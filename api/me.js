// api/me.js
//
// GET with "Authorization: Bearer <token>" -> confirms the session is still
// valid (token not expired, account still exists, password not changed since)
// and returns the account's current Drive config. Used when restoring a
// persisted login so a changed password / deleted account is picked up.
//
// PUT with the same header -> edits the logged-in user's own profile (Edit
// Profile popup). Only the fields that are sent are changed:
//   label         display name (also used for the dashboard greeting)
//   avatar        small JPEG data URL, or "" to remove the photo
//   rootFolderId  Google Drive folder the dashboard opens
//   email         login email
//   macroUrl      Apps Script web app URL
//   newPassword   new password
// Every change needs currentPassword to confirm.
// Accounts hardcoded in STATIC_ACCOUNTS (api/config.js) can't be edited here.
// (Kept in this file on purpose: Vercel's Hobby plan allows 12 functions.)

import { DuplicateEmailError, emailUsedByStaticAccount, updateAccount } from '../lib/accounts.js';
import { hashPassword, normalizeEmail, validateEmail, validatePassword, verifyPassword } from '../lib/passwords.js';
import { getSessionAccount } from '../lib/session.js';

const MAX_AVATAR_CHARS = 200 * 1024;
const AVATAR_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
const FOLDER_ID_RE = /^[A-Za-z0-9_-]{10,}$/;
const MACRO_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/.+/i;

async function updateProfile(req, res) {
    try {
        const session = await getSessionAccount(req);
        if (!session) return res.status(401).json({ error: 'Session expired. Please log in again.' });

        if (session.isStatic) {
            return res.status(400).json({
                error: 'This account is fixed in the server configuration and can\u2019t be edited here. Contact your administrator.'
            });
        }

        const body = req.body || {};
        const changes = {};

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

        if (body.rootFolderId !== undefined) {
            const folderId = String(body.rootFolderId || '').trim();
            if (!FOLDER_ID_RE.test(folderId)) {
                return res.status(400).json({ error: 'Enter a valid Google Drive folder link or ID.' });
            }
            if (folderId !== session.rootFolderId) changes.rootFolderId = folderId;
        }

        // Sensitive changes (email, Script URL, password) need the current password.
        let needsPassword = false;

        if (body.email !== undefined) {
            const email = normalizeEmail(body.email);
            if (email !== session.email) {
                const problem = validateEmail(email);
                if (problem) return res.status(400).json({ error: problem });
                if (emailUsedByStaticAccount(email)) {
                    return res.status(409).json({ error: 'An account with that email already exists.' });
                }
                changes.email = email;
                needsPassword = true;
            }
        }

        if (body.macroUrl !== undefined) {
            const macroUrl = String(body.macroUrl || '').trim();
            if (!MACRO_URL_RE.test(macroUrl)) {
                return res.status(400).json({ error: 'Apps Script URL must start with https://script.google.com/macros/s/' });
            }
            if (macroUrl !== session.macroUrl) {
                changes.macroUrl = macroUrl;
                needsPassword = true;
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
            needsPassword = true;
        }

        // Any change at all (name, photo, folder, email, Script URL, password) needs the current password.
        if (needsPassword || Object.keys(changes).length > 0) {
            if (!body.currentPassword) {
                return res.status(400).json({ error: 'Enter your current password to save changes.' });
            }
            if (!(await verifyPassword(String(body.currentPassword), session.passwordHash))) {
                return res.status(401).json({ error: 'Current password is incorrect.' });
            }
            if (passwordChanged) changes.passwordHash = await hashPassword(String(body.newPassword));
        }

        if (Object.keys(changes).length === 0) {
            return res.status(200).json({
                success: true,
                changed: false,
                account: { email: session.email, label: session.label, avatar: session.avatar || '' },
                config: { rootFolderId: session.rootFolderId, macroUrl: session.macroUrl }
            });
        }

        const updated = await updateAccount(session.id, { ...changes, updatedAt: new Date().toISOString() });
        if (!updated) return res.status(404).json({ error: 'Account not found.' });

        const next = { ...session, ...changes };
        return res.status(200).json({
            success: true,
            changed: true,
            passwordChanged,
            account: { email: next.email, label: next.label, avatar: next.avatar || '' },
            config: { rootFolderId: next.rootFolderId, macroUrl: next.macroUrl }
        });
    } catch (err) {
        if (err instanceof DuplicateEmailError) return res.status(409).json({ error: err.message });
        console.error('profile.js crashed:', err);
        return res.status(500).json({ error: 'Internal server error.' });
    }
}

export default async function handler(req, res) {
    if (req.method === 'PUT') return updateProfile(req, res);

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const account = await getSessionAccount(req);
        if (!account) return res.status(401).json({ authenticated: false, error: 'Session expired. Please log in again.' });

        return res.status(200).json({
            authenticated: true,
            account: { email: account.email, label: account.label, avatar: account.avatar || '' },
            config: { macroUrl: account.macroUrl, rootFolderId: account.rootFolderId }
        });
    } catch (err) {
        console.error('me.js crashed:', err);
        return res.status(500).json({ error: 'Internal server error.' });
    }
}
