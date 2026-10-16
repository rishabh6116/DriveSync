// api/reset-password.js
//
//   GET  ?token=...                  → { valid, expiresIn }  (expiresIn in seconds)
//   POST { token, password }         → sets the new password and burns the link
// A reset link works once and only for 10 minutes. Changing the password also
// invalidates every existing session token.

import { findAccountById, updateAccount } from '../lib/accounts.js';
import { hashPassword, validatePassword } from '../lib/passwords.js';
import { clearResetTokens, consumeResetToken, findResetToken } from '../lib/resetTokens.js';

export default async function handler(req, res) {
    // Never let a browser/CDN cache the validity of a link.
    res.setHeader('Cache-Control', 'no-store');
    try {
        if (req.method === 'GET') {
            const found = await findResetToken(String(req.query?.token || ''));
            return res.status(200).json({
                valid: Boolean(found),
                expiresIn: found ? Math.max(0, Math.floor((found.expiresAt.getTime() - Date.now()) / 1000)) : 0
            });
        }

        if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

        const { token, password } = req.body || {};
        const problem = validatePassword(password);
        if (problem) return res.status(400).json({ error: problem });

        // Burn the link first, atomically, so it can't be replayed.
        const accountId = await consumeResetToken(String(token || ''));
        const account = accountId ? await findAccountById(accountId) : null;
        if (!account || account.isStatic) {
            return res.status(400).json({ error: 'This reset link is invalid, expired, or already used.' });
        }

        await updateAccount(account.id, {
            passwordHash: await hashPassword(password),
            updatedAt: new Date().toISOString()
        });
        await clearResetTokens(account.id); // also drop any other pending links
        return res.status(200).json({ success: true });
    } catch (err) {
        console.error('reset-password.js crashed:', err);
        return res.status(500).json({ error: 'Internal server error.' });
    }
}
