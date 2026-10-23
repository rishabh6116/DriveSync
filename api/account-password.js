// api/account-password.js
//
// Lets a logged-in user (identified by their session token) change their own
// password and/or their Apps Script web app URL (macroUrl). The current
// password must always be confirmed.
//
// Only accounts stored in the database can be updated at
// runtime. Accounts hardcoded in STATIC_ACCOUNTS (api/config.js) are fixed in
// source and return a friendly error instead.

import { updateAccount } from '../lib/accounts.js';
import { hashPassword, validatePassword, verifyPassword } from '../lib/passwords.js';
import { getSessionAccount } from '../lib/session.js';

export default async function handler(req, res) {
    if (req.method !== 'PUT') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { currentPassword, newPassword, newMacroUrl } = req.body || {};

    if (!currentPassword) {
        return res.status(400).json({ error: 'currentPassword is required.' });
    }

    const wantsPasswordChange = !!newPassword;
    const wantsMacroUrlChange = !!(newMacroUrl && newMacroUrl.trim());

    if (!wantsPasswordChange && !wantsMacroUrlChange) {
        return res.status(400).json({ error: 'Nothing to update — enter a new password and/or a new script URL.' });
    }

    if (wantsPasswordChange) {
        const pwError = validatePassword(newPassword);
        if (pwError) return res.status(400).json({ error: pwError.replace('Password', 'New password') });
        if (newPassword === currentPassword) {
            return res.status(400).json({ error: 'New password must be different from the current one.' });
        }
    }

    let cleanMacroUrl = null;
    if (wantsMacroUrlChange) {
        cleanMacroUrl = newMacroUrl.trim();
        if (!/^https:\/\/script\.google\.com\/macros\/.+\/exec$/.test(cleanMacroUrl)) {
            return res.status(400).json({
                error: 'That doesn\u2019t look like a valid Apps Script web app URL. It should look like https://script.google.com/macros/s/.../exec'
            });
        }
    }

    try {
        const session = await getSessionAccount(req);
        if (!session) return res.status(401).json({ error: 'Session expired. Please log in again.' });

        if (session.isStatic) {
            return res.status(400).json({
                error: 'This account\u2019s password is fixed in the server configuration and can\u2019t be changed here. Contact your administrator.'
            });
        }

        if (!(await verifyPassword(currentPassword, session.passwordHash))) {
            return res.status(401).json({ error: 'Current password is incorrect.' });
        }

        const updated = await updateAccount(session.id, {
            ...(wantsPasswordChange ? { passwordHash: await hashPassword(newPassword) } : {}),
            ...(wantsMacroUrlChange ? { macroUrl: cleanMacroUrl } : {}),
            updatedAt: new Date().toISOString()
        });
        if (!updated) return res.status(404).json({ error: 'Account not found.' });

        return res.status(200).json({
            success: true,
            passwordChanged: wantsPasswordChange,
            macroUrlChanged: wantsMacroUrlChange,
            macroUrl: wantsMacroUrlChange ? cleanMacroUrl : undefined
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
