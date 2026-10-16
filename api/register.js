// api/register.js
//
// Public self-registration, used by the "Register" link on the sign-in screen.
//
//   GET  → { enabled }   whether the Register link should be shown
//   POST → { label, email, password, macroUrl, rootFolderId }
//          creates a new account in the MongoDB "accounts" collection
//
// Unlike /api/self-add-account this does not require a session, because the
// person registering has no account yet. To switch public sign-ups off, set
// the environment variable REGISTRATION_ENABLED=false in Vercel and redeploy.
// The unique index on `email` still guarantees no duplicate accounts.

import { DuplicateEmailError, emailUsedByStaticAccount, insertAccount } from '../lib/accounts.js';
import { hashPassword, normalizeEmail, validateEmail, validatePassword } from '../lib/passwords.js';

const registrationEnabled = () => String(process.env.REGISTRATION_ENABLED || 'true').toLowerCase() !== 'false';

// Best-effort spam guard (per warm serverless instance), same approach as api/auth.js.
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

export default async function handler(req, res) {
    if (req.method === 'GET') {
        return res.status(200).json({ enabled: registrationEnabled() });
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    if (!registrationEnabled()) {
        return res.status(403).json({ error: 'Registration is currently closed.' });
    }

    const { label, email, password, macroUrl, rootFolderId } = req.body || {};
    const cleanEmail = normalizeEmail(email);
    const cleanLabel = String(label || '').trim();
    const cleanMacroUrl = String(macroUrl || '').trim();
    const cleanFolderId = String(rootFolderId || '').trim();

    if (!cleanLabel || !cleanEmail || !password || !cleanMacroUrl || !cleanFolderId) {
        return res.status(400).json({ error: 'Name, email, password, Apps Script URL, and root folder ID are all required.' });
    }

    const problem = validateEmail(cleanEmail) || validatePassword(password);
    if (problem) return res.status(400).json({ error: problem });

    if (!/^https:\/\/script\.google\.com\/macros\/s\/.+/i.test(cleanMacroUrl)) {
        return res.status(400).json({ error: 'Apps Script URL must start with https://script.google.com/macros/s/' });
    }

    if (tooManyAttempts(req)) {
        return res.status(429).json({ error: 'Too many sign-up attempts. Please try again later.' });
    }

    try {
        if (emailUsedByStaticAccount(cleanEmail)) {
            return res.status(409).json({ error: 'An account with that email already exists.' });
        }

        const newAccount = {
            id: `acct_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            label: cleanLabel.slice(0, 80),
            email: cleanEmail,
            passwordHash: await hashPassword(password),
            macroUrl: cleanMacroUrl,
            rootFolderId: cleanFolderId,
            createdAt: new Date().toISOString(),
            addedBy: 'public-register'
        };

        await insertAccount(newAccount);
        return res.status(201).json({ success: true, email: newAccount.email });
    } catch (err) {
        if (err instanceof DuplicateEmailError) return res.status(409).json({ error: err.message });
        console.error('register.js crashed:', err);
        return res.status(500).json({ error: 'Internal server error.' });
    }
}
