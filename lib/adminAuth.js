// lib/adminAuth.js
//
// Verifies the admin passcode used to unlock /adminaccount.
//
// Until the admin changes it, the passcode is ADMIN_PASSCODE from the
// environment. After "Change Password" inside the admin panel, only a scrypt
// hash of the new passcode is stored in MongoDB (settings → admin_passcode)
// and it takes over from then on — no redeploy needed.
//
// If the database can't be reached, verification fails closed.

import { createHash, timingSafeEqual } from 'crypto';
import { ADMIN_PASSCODE } from './config.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { getSetting, saveSetting } from './settings.js';

const SETTING_KEY = 'admin_passcode';

const digest = (v) => createHash('sha256').update(String(v)).digest();

export async function isValidAdminPasscode(provided) {
    if (!provided || typeof provided !== 'string') return false;

    try {
        const stored = await getSetting(SETTING_KEY);
        if (stored && stored.passcodeHash) {
            return await verifyPassword(provided, stored.passcodeHash);
        }
    } catch (err) {
        console.error('Failed to load admin passcode from MongoDB:', err);
        return false;
    }

    return Boolean(ADMIN_PASSCODE) && timingSafeEqual(digest(provided), digest(ADMIN_PASSCODE));
}

export async function saveAdminPasscode(newPasscode) {
    await saveSetting(SETTING_KEY, { passcodeHash: await hashPassword(newPasscode), updatedAt: new Date().toISOString() });
    return true;
}
