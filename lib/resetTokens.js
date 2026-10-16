// lib/resetTokens.js
//
// One-time password reset tokens. Only a SHA-256 hash of the token is stored
// (collection "password_resets"), so a database leak can't be used to reset
// accounts. Tokens expire after 10 minutes, can be used exactly once, and are
// removed automatically.

import { createHash, randomBytes } from 'crypto';
import { getDb } from './db.js';

export const RESET_TTL_MINUTES = 10;
const TTL_MS = RESET_TTL_MINUTES * 60 * 1000;
const hash = (t) => createHash('sha256').update(String(t)).digest('hex');
const validShape = (t) => typeof t === 'string' && /^[a-f0-9]{64}$/.test(t);

let indexReady = null;
async function collection() {
    const col = (await getDb()).collection('password_resets');
    if (!indexReady) {
        indexReady = Promise.all([
            col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl' }),
            col.createIndex({ tokenHash: 1 }, { unique: true, name: 'token_unique' })
        ]).catch(err => { indexReady = null; throw err; });
    }
    await indexReady;
    return col;
}

export async function createResetToken(account) {
    const col = await collection();
    await col.deleteMany({ accountId: account.id }); // only the newest link works
    const token = randomBytes(32).toString('hex');
    await col.insertOne({
        tokenHash: hash(token),
        accountId: account.id,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + TTL_MS)
    });
    return token;
}

// Read-only check (used when the reset page opens).
// Returns { accountId, expiresAt } for a valid, unexpired token, else null.
export async function findResetToken(token) {
    if (!validShape(token)) return null;
    const doc = await (await collection()).findOne({ tokenHash: hash(token) });
    if (!doc || doc.expiresAt.getTime() <= Date.now()) return null;
    return { accountId: doc.accountId, expiresAt: doc.expiresAt };
}

// Atomically uses up a token: it is deleted in the same step it is read, so the
// same link can never be used twice (even by two simultaneous requests).
// Returns the accountId, or null if the token is unknown, used, or expired.
export async function consumeResetToken(token) {
    if (!validShape(token)) return null;
    const doc = await (await collection()).findOneAndDelete({
        tokenHash: hash(token),
        expiresAt: { $gt: new Date() }
    });
    return doc ? doc.accountId : null;
}

export async function clearResetTokens(accountId) {
    await (await collection()).deleteMany({ accountId });
}
