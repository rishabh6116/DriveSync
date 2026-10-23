// lib/accounts.js
//
// Accounts live in the MongoDB "accounts" collection (added through /admin or
// the self-service "Add Account" link). Static accounts can also be hardcoded
// in api/config.js as { email, passwordHash, macroUrl, rootFolderId }.
//
// Account shape: { id, label, email, passwordHash, macroUrl, rootFolderId, ... }
// A unique index on `email` guarantees no two accounts share an email.

import { STATIC_ACCOUNTS } from '../api/config.js';
import { getDb } from './db.js';

export class DuplicateEmailError extends Error {
    constructor() {
        super('An account with that email already exists.');
        this.name = 'DuplicateEmailError';
    }
}

const collection = async () => (await getDb()).collection('accounts');
const clean = (doc) => {
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return rest;
};

export function getStaticAccounts() {
    return STATIC_ACCOUNTS
        .filter(a => a.email && a.passwordHash && a.macroUrl && a.rootFolderId)
        .map(a => ({
            ...a,
            id: a.id || `static_${String(a.email).trim().toLowerCase()}`,
            email: String(a.email).trim().toLowerCase(),
            label: a.label || a.email,
            isStatic: true
        }));
}

export async function getDynamicAccounts() {
    const docs = await (await collection()).find({}).sort({ createdAt: 1 }).toArray();
    return docs.map(clean);
}

export async function findDynamicById(id) {
    return clean(await (await collection()).findOne({ id }));
}

// Used by login: static accounts first, then a single indexed lookup.
export async function findAccountByEmail(email) {
    const fixed = getStaticAccounts().find(a => a.email === email);
    if (fixed) return fixed;
    return clean(await (await collection()).findOne({ email }));
}

// Used by session checks.
export async function findAccountById(id) {
    const fixed = getStaticAccounts().find(a => a.id === id);
    if (fixed) return fixed;
    return findDynamicById(id);
}

export function emailUsedByStaticAccount(email) {
    return getStaticAccounts().some(a => a.email === email);
}

function rethrowDuplicate(err) {
    if (err && err.code === 11000) throw new DuplicateEmailError();
    throw err;
}

export async function insertAccount(account) {
    try {
        await (await collection()).insertOne({ ...account });
    } catch (err) {
        rethrowDuplicate(err);
    }
}

// Returns false if no account with that id exists.
export async function updateAccount(id, fields) {
    try {
        const result = await (await collection()).updateOne({ id }, { $set: fields });
        return result.matchedCount > 0;
    } catch (err) {
        rethrowDuplicate(err);
    }
}

// Returns false if no account with that id exists.
export async function deleteAccount(id) {
    const result = await (await collection()).deleteOne({ id });
    return result.deletedCount > 0;
}

// What is safe to send to a browser: never the password hash.
export function publicAccount(a) {
    return {
        id: a.id,
        label: a.label,
        email: a.email || '',
        macroUrl: a.macroUrl,
        rootFolderId: a.rootFolderId,
        hasPassword: Boolean(a.passwordHash),
        createdAt: a.createdAt
    };
}
