// api/forgot-password.js
//
// POST { email } → emails a 10-minute, single-use password reset link.
// Always answers with the same success message so the form can't be used to
// find out which emails are registered.

import { findAccountByEmail } from '../lib/accounts.js';
import { mailConfigured, sendMail } from '../lib/mailer.js';
import { normalizeEmail, validateEmail } from '../lib/passwords.js';
import { RESET_TTL_MINUTES, createResetToken } from '../lib/resetTokens.js';

const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const attempts = new Map();

function tooManyAttempts(req) {
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const entry = attempts.get(ip);
    if (!entry || Date.now() - entry.first > WINDOW_MS) {
        attempts.set(ip, { count: 1, first: Date.now() });
        return false;
    }
    entry.count++;
    return entry.count > MAX_PER_WINDOW;
}

function baseUrl(req) {
    if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || (String(host).startsWith('localhost') ? 'http' : 'https');
    return `${proto}://${host}`;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const email = normalizeEmail((req.body || {}).email);
    const problem = validateEmail(email);
    if (problem) return res.status(400).json({ error: problem });

    if (tooManyAttempts(req)) {
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    if (!mailConfigured()) {
        console.error('forgot-password: SMTP is not configured.');
        return res.status(500).json({ error: 'Password reset email is not set up on the server.' });
    }

    try {
        const account = await findAccountByEmail(email);
        // Static (config-file) accounts have fixed passwords and can't be reset here.
        if (account && !account.isStatic) {
            const token = await createResetToken(account);
            const link = `${baseUrl(req)}/reset-password?token=${token}`;
            await sendMail({
                to: account.email,
                subject: 'Reset your DriveSync password',
                text: `Use this link to choose a new password (valid for ${RESET_TTL_MINUTES} minutes, one use only):\n\n${link}\n\nIf you didn't request this, you can ignore this email.`,
                html: `<p>Use the button below to choose a new password. The link is valid for ${RESET_TTL_MINUTES} minutes and can be used only once.</p>
<p><a href="${link}" style="display:inline-block;padding:12px 22px;background:#3b82f6;color:#fff;border-radius:10px;text-decoration:none;font-weight:600">Reset password</a></p>
<p style="color:#666;font-size:13px">Or open: ${link}<br>If you didn't request this, you can ignore this email.</p>`
            });
        }
        return res.status(200).json({ success: true });
    } catch (err) {
        console.error('forgot-password.js crashed:', err);
        return res.status(500).json({ error: 'Could not send the reset email. Please try again.' });
    }
}
