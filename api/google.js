// api/google.js
//
// One function for the whole "Google" side (Vercel Hobby allows 12 functions):
//
//   GET  /api/google                   → { configured }  (are the Google keys set?)
//   GET  /api/google?action=login      → redirects to Google (sign in / sign up)
//   GET  /api/google?state=...&code=.. → Google's redirect back (the callback)
//   POST /api/google { action: "connect" }  (Bearer token)
//                                      → { url } to connect a Drive to the logged-in account
//
// After the callback the browser is sent to the home page with the result in
// the URL fragment (never sent to servers or logged):
//   #gauth=<session token>[&setpw=1][&warn=drive_error]   signed in with Google
//   #gdone=1                                              Drive connected
//   #gerror=<code>                                        something went wrong

import {
    findAccountByEmail, findAccountByGoogleId, findAccountById,
    DuplicateEmailError, insertAccount, updateAccount
} from '../lib/accounts.js';
import {
    NONCE_COOKIE, buildAuthUrl, clearNonceCookie, decodeIdToken, encryptToken, ensureRootFolder,
    exchangeCode, fetchAvatarDataUrl, googleConfigured, hasDriveScope, makeState, nonceCookie,
    readCookie, readState
} from '../lib/google.js';
import { getSessionAccount, signSession } from '../lib/session.js';

const registrationEnabled = () => String(process.env.REGISTRATION_ENABLED || 'true').toLowerCase() !== 'false';

function redirect(res, location, cookies = []) {
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 302;
    res.setHeader('Location', location);
    res.end();
}

const toHome = (res, fragment) => redirect(res, `/#${fragment}`, [clearNonceCookie()]);
const fail = (res, code) => toHome(res, `gerror=${encodeURIComponent(code)}`);

export default async function handler(req, res) {
    try {
        if (req.method === 'GET') {
            const q = req.query || {};
            if (q.action === 'login') return startLogin(req, res);
            if (q.state || q.error || q.code) return await callback(req, res, q);
            return res.status(200).json({ configured: googleConfigured() });
        }

        if (req.method === 'POST') {
            const body = req.body || {};
            if (body.action === 'connect') return await startConnect(req, res);
            return res.status(400).json({ error: 'Unknown action.' });
        }

        return res.status(405).json({ error: 'Method Not Allowed' });
    } catch (err) {
        console.error('google.js crashed:', err);
        if (req.method === 'GET') return fail(res, 'server');
        return res.status(500).json({ error: 'Internal server error.' });
    }
}

// --------------------------------------------------------------------------
function startLogin(req, res) {
    if (!googleConfigured()) return fail(res, 'not_configured');
    const { state, nonce } = makeState({ mode: 'login' });
    redirect(res, buildAuthUrl(req, { state }), [nonceCookie(nonce, req)]);
}

async function startConnect(req, res) {
    if (!googleConfigured()) {
        return res.status(400).json({ error: 'Google sign-in is not set up on this server yet.' });
    }
    const account = await getSessionAccount(req);
    if (!account) return res.status(401).json({ error: 'Session expired. Please log in again.' });
    if (account.isStatic) {
        return res.status(400).json({ error: 'This account is fixed in the server configuration and can\u2019t connect Google Drive.' });
    }

    const { state, nonce } = makeState({ mode: 'connect', uid: account.id });
    // Asking for consent again guarantees Google sends a refresh token.
    const url = buildAuthUrl(req, { state, forceConsent: true, loginHint: account.googleEmail || account.email });
    res.setHeader('Set-Cookie', nonceCookie(nonce, req));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ url });
}

// --------------------------------------------------------------------------
async function callback(req, res, q) {
    if (q.error) return fail(res, q.error === 'access_denied' ? 'cancelled' : 'google_error');

    const state = readState(q.state);
    if (!state || !q.code || readCookie(req, NONCE_COOKIE) !== state.n) return fail(res, 'state');

    let tokens;
    try {
        tokens = await exchangeCode(String(q.code), req);
    } catch (err) {
        console.error('Google code exchange failed:', err.message);
        return fail(res, 'exchange');
    }

    const claims = decodeIdToken(tokens.id_token);
    if (!claims || !claims.sub || !claims.email || claims.email_verified === false) return fail(res, 'profile');

    const driveGranted = hasDriveScope(tokens.scope);
    const refresh = tokens.refresh_token || '';
    const email = String(claims.email).trim().toLowerCase();

    return state.mode === 'connect'
        ? connectDrive(res, state, claims, tokens, driveGranted, refresh)
        : signInWithGoogle(res, email, claims, tokens, driveGranted, refresh);
}

// Saves the Google link + encrypted refresh token + root folder on an account.
async function saveDriveConnection(account, claims, tokens, refresh) {
    const previouslyGoogle = Boolean(account.driveRefreshToken);
    const rootFolderId = await ensureRootFolder(tokens.access_token, previouslyGoogle ? account.rootFolderId : '');
    const fields = {
        googleId: claims.sub,
        googleEmail: String(claims.email).toLowerCase(),
        rootFolderId,
        driveConnectedAt: new Date().toISOString()
    };
    if (refresh) fields.driveRefreshToken = encryptToken(refresh);
    return fields;
}

async function connectDrive(res, state, claims, tokens, driveGranted, refresh) {
    const account = await findAccountById(state.uid);
    if (!account || account.isStatic) return fail(res, 'account');
    if (!driveGranted) return fail(res, 'drive_denied');

    const other = await findAccountByGoogleId(claims.sub);
    if (other && other.id !== account.id) return fail(res, 'google_in_use');
    if (!refresh && !account.driveRefreshToken) return fail(res, 'no_refresh');

    let fields;
    try {
        fields = await saveDriveConnection(account, claims, tokens, refresh);
    } catch (err) {
        console.error('Connecting Drive failed:', err.message);
        return fail(res, 'drive_error');
    }
    if (!account.avatar) {
        const avatar = await fetchAvatarDataUrl(claims.picture);
        if (avatar) fields.avatar = avatar;
    }
    await updateAccount(account.id, { ...fields, updatedAt: new Date().toISOString() });
    return toHome(res, 'gdone=1');
}

async function signInWithGoogle(res, email, claims, tokens, driveGranted, refresh) {
    let account = await findAccountByGoogleId(claims.sub);
    let isNew = false;

    if (!account) {
        const byEmail = await findAccountByEmail(email);
        if (byEmail) {
            // Same verified email as an existing email/password account → link them.
            if (byEmail.isStatic) return fail(res, 'static_account');
            account = byEmail;
        } else {
            if (!registrationEnabled()) return fail(res, 'registration_closed');
            const avatar = await fetchAvatarDataUrl(claims.picture);
            account = {
                id: `acct_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                label: String(claims.name || email.split('@')[0]).trim().slice(0, 80) || email,
                email,
                passwordHash: '',            // can be set later from Edit Profile
                googleId: claims.sub,
                googleEmail: email,
                createdAt: new Date().toISOString(),
                addedBy: 'google-signin'
            };
            if (avatar) account.avatar = avatar;
            try {
                await insertAccount(account);
            } catch (err) {
                if (err instanceof DuplicateEmailError) return fail(res, 'exists');
                throw err;
            }
            isNew = true;
        }
    }

    if (account.isStatic) return fail(res, 'static_account');

    const updates = {};
    if (!account.googleId) { updates.googleId = claims.sub; updates.googleEmail = email; }
    if (!account.avatar && !isNew) {
        const avatar = await fetchAvatarDataUrl(claims.picture);
        if (avatar) { updates.avatar = avatar; account.avatar = avatar; }
    }

    let warn = '';
    if (driveGranted && (refresh || account.driveRefreshToken)) {
        if (refresh) {
            try {
                Object.assign(updates, await saveDriveConnection(account, claims, tokens, refresh));
            } catch (err) {
                console.error('Connecting Drive during sign-in failed:', err.message);
                warn = 'drive_error';
            }
        }
    }

    if (Object.keys(updates).length) {
        await updateAccount(account.id, { ...updates, updatedAt: new Date().toISOString() });
        Object.assign(account, updates);
    }

    const token = signSession(account);
    let fragment = `gauth=${encodeURIComponent(token)}`;
    if (isNew) fragment += '&setpw=1';
    if (warn) fragment += `&warn=${warn}`;
    return toHome(res, fragment);
}
