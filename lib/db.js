// lib/db.js
//
// One shared MongoDB connection per serverless instance. The client is cached
// on globalThis so warm invocations (and hot reloads) reuse it instead of
// opening a new connection on every request.
//
// Collections:
//   accounts  – { id, label, email, passwordHash, macroUrl, rootFolderId, ... }
//   settings  – { _id: 'feature_settings' | 'admin_passcode', value, updatedAt }

import { MongoClient } from 'mongodb';
import { MONGODB_URI, MONGODB_DB } from '../api/config.js';

const state = (globalThis.__driveSyncMongo ||= { dbPromise: null, indexesPromise: null });

async function ensureIndexes(db) {
    const accounts = db.collection('accounts');
    await accounts.createIndex({ email: 1 }, { unique: true, name: 'email_unique' });
    await accounts.createIndex({ id: 1 }, { unique: true, name: 'id_unique' });
}

export async function getDb() {
    if (!state.dbPromise) {
        if (!MONGODB_URI) throw new Error('MONGODB_URI is not configured on the server.');
        const client = new MongoClient(MONGODB_URI, { maxPoolSize: 5, serverSelectionTimeoutMS: 8000 });
        state.dbPromise = client.connect()
            .then(c => c.db(MONGODB_DB))
            .catch(err => { state.dbPromise = null; throw err; });
    }
    const db = await state.dbPromise;

    if (!state.indexesPromise) {
        state.indexesPromise = ensureIndexes(db).catch(err => { state.indexesPromise = null; throw err; });
    }
    await state.indexesPromise;

    return db;
}
