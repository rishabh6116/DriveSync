// api/auth.js
//
// POST { email, password }  → verifies credentials, returns a signed session
//                             token plus the account's Drive config.
//
// Accounts come from STATIC_ACCOUNTS (lib/config.js) and from the MongoDB
// "accounts" collection (see lib/accounts.js).

import { findAccountByEmail } from '../lib/accounts.js';
import { accountForBrowser, driveConfigFor } from '../lib/driveConfig.js';
import { burnPasswordCheck, normalizeEmail, verifyPassword } from '../lib/passwords.js';
import { signSession } from '../lib/session.js';

// Best-effort brute-force guard. Serverless instances don't share memory, so
// this only limits attempts that hit the same warm instance — the client
// also enforces its own lockout.
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
const failures = new Map();

function limiterKey(req, email) {
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    return `${ip}|${email}`;
}

function isBlocked(key) {
    const entry = failures.get(key);
    if (!entry) return false;
    if (Date.now() - entry.first > FAIL_WINDOW_MS) { failures.delete(key); return false; }
    return entry.count >= MAX_FAILS;
}

function recordFailure(key) {
    const entry = failures.get(key);
    if (!entry || Date.now() - entry.first > FAIL_WINDOW_MS) failures.set(key, { count: 1, first: Date.now() });
    else entry.count++;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const body = req.body || {};
        const email = normalizeEmail(body.email);
        const password = typeof body.password === 'string' ? body.password : '';

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required.' });
        }

        const key = limiterKey(req, email);
        if (isBlocked(key)) {
            return res.status(429).json({ error: 'Too many failed attempts. Please try again later.' });
        }

        const account = await findAccountByEmail(email);

        let ok = false;
        if (account && !account.passwordHash) {
            // Created with "Continue with Google" and no password set yet.
            await burnPasswordCheck(password);
            return res.status(401).json({
                authenticated: false,
                googleOnly: true,
                error: 'This account uses Google sign-in. Tap "Continue with Google", then set a password from Edit Profile if you also want to use email and password.'
            });
        }
        if (account) {
            ok = await verifyPassword(password, account.passwordHash);
        } else {
            await burnPasswordCheck(password); // keep timing similar for unknown emails
        }

        if (!ok) {
            recordFailure(key);
            return res.status(401).json({ authenticated: false, error: 'Invalid email or password.' });
        }

        failures.delete(key);

        return res.status(200).json({
            authenticated: true,
            token: signSession(account),
            account: accountForBrowser(account),
            config: driveConfigFor(account)
        });
    } catch (err) {
        console.error('auth.js crashed:', err);
        return res.status(500).json({ error: 'Internal server error.' });
    }
}
