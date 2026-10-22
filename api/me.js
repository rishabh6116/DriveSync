// api/me.js
//
// GET  (Bearer token)             → confirms the session is still valid (token not
//                                   expired, account exists, password unchanged) and
//                                   returns the account + how its Drive is reached.
// GET  ?drive=token (Bearer)      → a fresh, short-lived Google access token for the
//                                   account's connected Drive (the browser's Drive
//                                   bridge uses it; the refresh token never leaves
//                                   the server).
// PUT  (Bearer)                   → edit the logged-in user's own profile. Only the
//                                   fields that are sent are changed:
//        label, avatar ("" removes), email, newPassword,
//        rootFolderId + macroUrl (older Apps Script accounts only),
//        disconnectDrive: true
//      Accounts that already have a password must send currentPassword for any
//      change. Accounts created with "Continue with Google" have no password yet,
//      so they can set one without it.
//
// (Kept in this file on purpose: Vercel's Hobby plan allows 12 functions.)
// Accounts hardcoded in STATIC_ACCOUNTS (lib/config.js) can't be edited here.

import { DuplicateEmailError, emailUsedByStaticAccount, updateAccount } from '../lib/accounts.js';
import { accountForBrowser, driveConfigFor, driveModeOf } from '../lib/driveConfig.js';
import { decryptToken, hasDriveScope, refreshAccessToken, revokeToken } from '../lib/google.js';
import { hashPassword, normalizeEmail, validateEmail, validatePassword, verifyPassword } from '../lib/passwords.js';
import { getSessionAccount, signSession } from '../lib/session.js';

const MAX_AVATAR_CHARS = 200 * 1024;
const AVATAR_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
const FOLDER_ID_RE = /^[A-Za-z0-9_-]{10,}$/;
const MACRO_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/.+/i;

const payloadFor = (account, extra = {}) => ({
    account: accountForBrowser(account),
    config: driveConfigFor(account),
    ...extra
});

async function driveToken(res, account) {
    res.setHeader('Cache-Control', 'no-store');
    if (!account.driveRefreshToken) {
        return res.status(409).json({ needsConnect: true, error: 'Google Drive is not connected yet.' });
    }
    try {
        const tokens = await refreshAccessToken(decryptToken(account.driveRefreshToken));
        // Accounts connected before the switch to the full `drive` scope only
        // hold `drive.file` and cannot see files added by hand in Google Drive.
        // Ask them to connect once more so Google grants the wider scope.
        if (tokens.scope && !hasDriveScope(tokens.scope)) {
            return res.status(409).json({ needsConnect: true, error: 'DriveSync needs updated Google Drive permission. Please tap Connect and allow it.' });
        }
        return res.status(200).json({ accessToken: tokens.access_token, expiresIn: tokens.expires_in || 3600 });
    } catch (err) {
        if (err.code === 'invalid_grant') {
            // The user removed DriveSync's access in their Google account.
            await updateAccount(account.id, { driveRefreshToken: '' });
            return res.status(409).json({ needsConnect: true, error: 'Google Drive access was removed. Please connect it again.' });
        }
        console.error('Drive token refresh failed:', err.message);
        return res.status(502).json({ error: 'Could not reach Google Drive right now. Please try again.' });
    }
}

async function updateProfile(req, res, session) {
    if (session.isStatic) {
        return res.status(400).json({
            error: 'This account is fixed in the server configuration and can\u2019t be edited here. Contact your administrator.'
        });
    }

    const body = req.body || {};
    const changes = {};
    const hasPassword = Boolean(session.passwordHash);
    const scriptAccount = driveModeOf(session) === 'script';

    if (body.label !== undefined) {
        const label = String(body.label || '').trim().slice(0, 80);
        if (!label) return res.status(400).json({ error: 'Name can\u2019t be empty.' });
        if (label !== session.label) changes.label = label;
    }

    if (body.avatar !== undefined) {
        const avatar = typeof body.avatar === 'string' ? body.avatar.trim() : '';
        if (avatar && (avatar.length > MAX_AVATAR_CHARS || !AVATAR_RE.test(avatar))) {
            return res.status(400).json({ error: 'Profile photo is invalid or too large.' });
        }
        if (avatar !== (session.avatar || '')) changes.avatar = avatar;
    }

    // Folder + Script URL only apply to older Apps Script accounts.
    if (scriptAccount && body.rootFolderId !== undefined) {
        const folderId = String(body.rootFolderId || '').trim();
        if (!FOLDER_ID_RE.test(folderId)) {
            return res.status(400).json({ error: 'Enter a valid Google Drive folder link or ID.' });
        }
        if (folderId !== session.rootFolderId) changes.rootFolderId = folderId;
    }
    if (scriptAccount && body.macroUrl !== undefined) {
        const macroUrl = String(body.macroUrl || '').trim();
        if (!MACRO_URL_RE.test(macroUrl)) {
            return res.status(400).json({ error: 'Apps Script URL must start with https://script.google.com/macros/s/' });
        }
        if (macroUrl !== session.macroUrl) changes.macroUrl = macroUrl;
    }

    if (body.email !== undefined) {
        const email = normalizeEmail(body.email);
        if (email !== session.email) {
            const problem = validateEmail(email);
            if (problem) return res.status(400).json({ error: problem });
            if (emailUsedByStaticAccount(email)) {
                return res.status(409).json({ error: 'An account with that email already exists.' });
            }
            changes.email = email;
        }
    }

    let passwordChanged = false;
    if (body.newPassword) {
        const newPassword = String(body.newPassword);
        const pwError = validatePassword(newPassword);
        if (pwError) return res.status(400).json({ error: pwError.replace('Password', 'New password') });
        if (body.currentPassword && newPassword === String(body.currentPassword)) {
            return res.status(400).json({ error: 'New password must be different from the current one.' });
        }
        passwordChanged = true;
    }

    const disconnectDrive = body.disconnectDrive === true && Boolean(session.driveRefreshToken);
    if (disconnectDrive) {
        changes.driveRefreshToken = '';
        changes.rootFolderId = '';
    }

    const somethingChanged = Object.keys(changes).length > 0 || passwordChanged;

    // Accounts that have a password must confirm it for ANY change.
    if (somethingChanged && hasPassword) {
        if (!body.currentPassword) {
            return res.status(400).json({ error: 'Enter your current password to save changes.' });
        }
        if (!(await verifyPassword(String(body.currentPassword), session.passwordHash))) {
            return res.status(401).json({ error: 'Current password is incorrect.' });
        }
    }
    if (passwordChanged) changes.passwordHash = await hashPassword(String(body.newPassword));

    if (!somethingChanged) {
        return res.status(200).json(payloadFor(session, { success: true, changed: false }));
    }

    if (disconnectDrive) {
        try { await revokeToken(decryptToken(session.driveRefreshToken)); } catch { /* best effort */ }
    }

    const updated = await updateAccount(session.id, { ...changes, updatedAt: new Date().toISOString() });
    if (!updated) return res.status(404).json({ error: 'Account not found.' });

    const next = { ...session, ...changes };
    // A new password invalidates old session tokens, so hand back a fresh one
    // (the user stays signed in on this device).
    return res.status(200).json(payloadFor(next, {
        success: true,
        changed: true,
        passwordChanged,
        ...(passwordChanged ? { token: signSession(next) } : {})
    }));
}

export default async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'PUT') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const account = await getSessionAccount(req);
        if (!account) {
            return res.status(401).json({ authenticated: false, error: 'Session expired. Please log in again.' });
        }

        if (req.method === 'PUT') return await updateProfile(req, res, account);

        if (req.query && req.query.drive === 'token') return await driveToken(res, account);

        return res.status(200).json(payloadFor(account, { authenticated: true }));
    } catch (err) {
        if (err instanceof DuplicateEmailError) return res.status(409).json({ error: err.message });
        console.error('me.js crashed:', err);
        return res.status(500).json({ error: 'Internal server error.' });
    }
}
