// api/register.js
//
// Public self-registration, used by the "Register" link on the sign-in screen.
//
//   GET  → { enabled }   whether the Register link should be shown
//   POST → { label, email, password, avatar? }
//          creates a new account in the MongoDB "accounts" collection
//
// Unlike /api/self-add-account this does not require a session, because the
// person registering has no account yet. To switch public sign-ups off, set
// the environment variable REGISTRATION_ENABLED=false in Vercel and redeploy.
// The unique index on `email` still guarantees no duplicate accounts.

import { googleConfigured } from '../lib/google.js';
import { DuplicateEmailError, emailUsedByStaticAccount, insertAccount } from '../lib/accounts.js';
import { hashPassword, normalizeEmail, validateEmail, validatePassword } from '../lib/passwords.js';

const registrationEnabled = () => String(process.env.REGISTRATION_ENABLED || 'true').toLowerCase() !== 'false';

// A 320x320 JPEG at ~85% quality is roughly 30-60 KB (about 80 KB as base64).
const MAX_AVATAR_CHARS = 200 * 1024;
const AVATAR_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;

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
        return res.status(200).json({ enabled: registrationEnabled(), googleEnabled: googleConfigured() });
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    if (!registrationEnabled()) {
        return res.status(403).json({ error: 'Registration is currently closed.' });
    }

    // Drive is connected after sign-in ("Connect Google Drive"), so no script
    // URL or folder ID is needed any more.
    const { label, email, password, avatar } = req.body || {};
    const cleanEmail = normalizeEmail(email);
    const cleanLabel = String(label || '').trim();

    if (!cleanLabel || !cleanEmail || !password) {
        return res.status(400).json({ error: 'Name, email and password are required.' });
    }

    const problem = validateEmail(cleanEmail) || validatePassword(password);
    if (problem) return res.status(400).json({ error: problem });

    // Optional profile photo: a small JPEG data URL, already cropped and
    // resized in the browser (320x320). Anything else is rejected.
    const cleanAvatar = typeof avatar === 'string' ? avatar.trim() : '';
    if (cleanAvatar && (cleanAvatar.length > MAX_AVATAR_CHARS || !AVATAR_RE.test(cleanAvatar))) {
        return res.status(400).json({ error: 'Profile photo is invalid or too large.' });
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
            createdAt: new Date().toISOString(),
            addedBy: 'public-register'
        };
        if (cleanAvatar) newAccount.avatar = cleanAvatar;

        await insertAccount(newAccount);
        return res.status(201).json({ success: true, email: newAccount.email });
    } catch (err) {
        if (err instanceof DuplicateEmailError) return res.status(409).json({ error: err.message });
        console.error('register.js crashed:', err);
        return res.status(500).json({ error: 'Internal server error.' });
    }
}
