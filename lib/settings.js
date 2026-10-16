// lib/settings.js — tiny key/value helper on the "settings" collection.

import { getDb } from './db.js';

export async function getSetting(key) {
    const db = await getDb();
    const doc = await db.collection('settings').findOne({ _id: key });
    return doc ? doc.value : null;
}

export async function saveSetting(key, value) {
    const db = await getDb();
    await db.collection('settings').replaceOne(
        { _id: key },
        { _id: key, value, updatedAt: new Date() },
        { upsert: true }
    );
    return true;
}
