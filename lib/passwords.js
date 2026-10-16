// lib/passwords.js
//
// Password hashing with Node's built-in scrypt (no extra dependency).
// Stored format:  scrypt$N$r$p$<salt b64>$<hash b64>

import { randomBytes, scrypt, timingSafeEqual } from 'crypto';

const N = 16384, R = 8, P = 1, KEYLEN = 64;

function derive(password, salt, n, r, p, keylen) {
    return new Promise((resolve, reject) => {
        scrypt(password, salt, keylen, { N: n, r, p }, (err, key) => (err ? reject(err) : resolve(key)));
    });
}

// No complexity or length rules: any non-empty string (even a single digit) is accepted.
export function validatePassword(password) {
    if (typeof password !== 'string' || password.length === 0) {
        return 'Please enter a password.';
    }
    return null;
}

export async function hashPassword(password) {
    const salt = randomBytes(16);
    const key = await derive(password, salt, N, R, P, KEYLEN);
    return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
    try {
        const [scheme, n, r, p, saltB64, hashB64] = String(stored || '').split('$');
        if (scheme !== 'scrypt') return false;
        const expected = Buffer.from(hashB64, 'base64');
        const actual = await derive(password, Buffer.from(saltB64, 'base64'), +n, +r, +p, expected.length);
        return expected.length === actual.length && timingSafeEqual(expected, actual);
    } catch {
        return false;
    }
}

// Used to burn the same CPU time when the email doesn't exist, so response
// time doesn't reveal which emails are registered.
let dummyHashPromise = null;
export async function burnPasswordCheck(password) {
    if (!dummyHashPromise) dummyHashPromise = hashPassword('dummy-password-for-timing');
    await verifyPassword(password, await dummyHashPromise);
}

export function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

export function validateEmail(email) {
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return 'Please enter a valid email address.';
    }
    return null;
}
