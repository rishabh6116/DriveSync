// lib/google.js
//
// Everything server-side that talks to Google:
//   - OAuth 2.0 "authorization code" flow (sign in + connect Drive)
//   - signed `state` values (CSRF protection)
//   - encrypting the refresh token before it is stored in MongoDB
//   - refreshing access tokens, creating the user's "DriveSync" folder
//
// Scope used for Drive is the full `drive` scope. (`drive.file` only lets an
// app see files it created itself, so anything a user drops into the DriveSync
// folder from drive.google.com would never show up in the dashboard.)

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { APP_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET, TOKEN_ENC_KEY } from './config.js';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
export const SCOPES = ['openid', 'email', 'profile', DRIVE_SCOPE];
export const ROOT_FOLDER_NAME = 'DriveSync';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const STATE_TTL_MS = 10 * 60 * 1000;

export const googleConfigured = () => Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

const b64u = (buf) => Buffer.from(buf).toString('base64url');

// ---------------------------------------------------------------------------
// Redirect URI: <site origin>/api/google  (must match Google Cloud Console)
// ---------------------------------------------------------------------------
export function siteOrigin(req) {
    if (APP_URL) return APP_URL;
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
    const proto = String(req.headers['x-forwarded-proto'] || (isLocal ? 'http' : 'https')).split(',')[0].trim();
    return `${proto}://${host}`;
}

export const redirectUri = (req) => `${siteOrigin(req)}/api/google`;

// ---------------------------------------------------------------------------
// Signed state (CSRF): { mode, uid?, n, exp } + HMAC. The random nonce `n` is
// also kept in a short-lived HttpOnly cookie and must match on the way back.
// ---------------------------------------------------------------------------
function hmac(data) {
    if (!SESSION_SECRET || SESSION_SECRET.length < 16) {
        throw new Error('SESSION_SECRET is not configured on the server (min 16 characters).');
    }
    return createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
}

export function makeState({ mode, uid }) {
    const nonce = randomBytes(16).toString('hex');
    const payload = b64u(JSON.stringify({ mode, uid: uid || '', n: nonce, exp: Date.now() + STATE_TTL_MS }));
    return { state: `${payload}.${hmac(payload)}`, nonce };
}

export function readState(state) {
    if (typeof state !== 'string') return null;
    const [payload, sig] = state.split('.');
    if (!payload || !sig) return null;
    const expected = Buffer.from(hmac(payload));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!data.exp || data.exp < Date.now() || !data.n) return null;
        return data;
    } catch {
        return null;
    }
}

export const NONCE_COOKIE = 'ds_gnonce';

export function nonceCookie(nonce, req) {
    const secure = siteOrigin(req).startsWith('https://') ? '; Secure' : '';
    return `${NONCE_COOKIE}=${nonce}; Path=/api/google; HttpOnly; SameSite=Lax; Max-Age=600${secure}`;
}

export const clearNonceCookie = () => `${NONCE_COOKIE}=; Path=/api/google; HttpOnly; SameSite=Lax; Max-Age=0`;

export function readCookie(req, name) {
    const header = String(req.headers.cookie || '');
    for (const part of header.split(';')) {
        const [k, ...rest] = part.trim().split('=');
        if (k === name) return rest.join('=');
    }
    return '';
}

export function buildAuthUrl(req, { state, loginHint, forceConsent }) {
    const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri(req),
        response_type: 'code',
        scope: SCOPES.join(' '),
        state,
        access_type: 'offline',          // ask for a refresh token
        include_granted_scopes: 'true',
        prompt: forceConsent ? 'consent select_account' : 'select_account'
    });
    if (loginHint) params.set('login_hint', loginHint);
    return `${AUTH_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Token endpoint calls
// ---------------------------------------------------------------------------
async function tokenRequest(params) {
    const resp = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, ...params })
    });
    let data = {};
    try { data = await resp.json(); } catch { /* handled below */ }
    if (!resp.ok) {
        const err = new Error(data.error_description || data.error || `Google token request failed (${resp.status})`);
        err.code = data.error || 'token_error';
        throw err;
    }
    return data;
}

export const exchangeCode = (code, req) =>
    tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri(req) });

export const refreshAccessToken = (refreshToken) =>
    tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' });

export async function revokeToken(token) {
    try {
        await fetch(REVOKE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token })
        });
    } catch { /* best effort */ }
}

// The id_token comes straight from Google's token endpoint over TLS, so its
// payload can be trusted without re-verifying the signature.
export function decodeIdToken(idToken) {
    try {
        const part = String(idToken || '').split('.')[1];
        return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

export const hasDriveScope = (scopeString) => String(scopeString || '').split(' ').includes(DRIVE_SCOPE);

// ---------------------------------------------------------------------------
// Refresh-token encryption (AES-256-GCM). Format: v1.<iv>.<tag>.<ciphertext>
// ---------------------------------------------------------------------------
function encKey() {
    const secret = TOKEN_ENC_KEY || SESSION_SECRET;
    if (!secret || secret.length < 16) throw new Error('TOKEN_ENC_KEY or SESSION_SECRET must be set (min 16 characters).');
    return createHash('sha256').update(`drivesync-token-key|${secret}`).digest();
}

export function encryptToken(plain) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encKey(), iv);
    const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return ['v1', b64u(iv), b64u(cipher.getAuthTag()), b64u(ct)].join('.');
}

export function decryptToken(stored) {
    const [v, iv, tag, ct] = String(stored || '').split('.');
    if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Stored Google token is unreadable.');
    const decipher = createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Drive helpers used while connecting
// ---------------------------------------------------------------------------

// Makes sure the user has a usable "DriveSync" root folder and returns its id.
// Reuses `existingId` when it still exists and isn't in the trash.
export async function ensureRootFolder(accessToken, existingId) {
    const headers = { Authorization: `Bearer ${accessToken}` };

    if (existingId && /^[A-Za-z0-9_-]{10,}$/.test(existingId)) {
        const check = await fetch(`${DRIVE_FILES_URL}/${existingId}?fields=id,trashed`, { headers });
        if (check.ok) {
            const info = await check.json();
            if (!info.trashed) return info.id;
        }
    }

    const resp = await fetch(`${DRIVE_FILES_URL}?fields=id`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: ROOT_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
    });
    if (!resp.ok) {
        let msg = '';
        try { msg = (await resp.json()).error?.message || ''; } catch { /* ignore */ }
        throw new Error(msg || `Could not create the DriveSync folder (${resp.status}).`);
    }
    return (await resp.json()).id;
}

// Downloads the Google profile picture and returns it as a small JPEG data
// URL (the same format the rest of the app stores), or '' if not possible.
export async function fetchAvatarDataUrl(pictureUrl) {
    try {
        const url = new URL(String(pictureUrl || ''));
        if (url.protocol !== 'https:' || !/(^|\.)googleusercontent\.com$/.test(url.hostname)) return '';
        const sized = url.href.replace(/=s\d+(-c)?$/, '') + '=s256-c';
        const resp = await fetch(sized);
        if (!resp.ok) return '';
        const type = String(resp.headers.get('content-type') || '');
        if (!type.startsWith('image/jpeg')) return '';
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length === 0 || buf.length > 140 * 1024) return '';
        return `data:image/jpeg;base64,${buf.toString('base64')}`;
    } catch {
        return '';
    }
}
