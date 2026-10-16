// lib/session.js
//
// Stateless signed session tokens (HMAC-SHA256). The browser keeps the token
// exactly where it used to keep the passcode (sessionStorage, mirrored to
// localStorage when the admin enables "stay logged in"), and sends it as
// "Authorization: Bearer <token>". The token carries the account id and a
// short fingerprint of the password hash, so changing the password (or
// deleting the account) invalidates every token issued before.

import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { SESSION_SECRET } from '../api/config.js';
import { findAccountById } from './accounts.js';

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fingerprint = (account) => createHash('sha256').update(String(account.passwordHash)).digest('hex').slice(0, 16);

function sign(data) {
    if (!SESSION_SECRET || SESSION_SECRET.length < 16) {
        throw new Error('SESSION_SECRET is not configured on the server (min 16 characters).');
    }
    return createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
}

export function signSession(account) {
    const payload = b64u(JSON.stringify({ sub: account.id, pv: fingerprint(account), exp: Date.now() + TOKEN_TTL_MS }));
    return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
    if (typeof token !== 'string') return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;

    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!data.sub || !data.exp || data.exp < Date.now()) return null;
        return data;
    } catch {
        return null;
    }
}

export function readBearerToken(req) {
    const header = req.headers['authorization'] || '';
    return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

// Returns the full account record for a valid session, or null.
export async function getSessionAccount(req) {
    const data = verifyToken(readBearerToken(req));
    if (!data) return null;
    const account = await findAccountById(data.sub);
    if (!account || fingerprint(account) !== data.pv) return null;
    return account;
}
