// api/admin-passcode.js
//
// Lets an already-unlocked admin change the passcode used to access
// /adminaccount. Only a hash of the new passcode is stored in MongoDB
// (via lib/adminAuth.js) and it overrides ADMIN_PASSCODE from the
// environment from then on.

import { isValidAdminPasscode, saveAdminPasscode } from '../lib/adminAuth.js';

export default async function handler(req, res) {
    if (req.method !== 'PUT') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const provided = req.headers['x-admin-passcode'];
    const { currentPasscode, newPasscode } = req.body || {};

    if (!currentPasscode || !newPasscode) {
        return res.status(400).json({ error: 'currentPasscode and newPasscode are both required.' });
    }

    try {
        // Require BOTH the session header and the freshly-typed "current
        // passcode" field to be valid, so a stale session can't be used to
        // silently rotate it.
        if (!(await isValidAdminPasscode(provided)) || !(await isValidAdminPasscode(currentPasscode))) {
            return res.status(401).json({ error: 'Current passcode is incorrect.' });
        }

        if (newPasscode.length < 4) {
            return res.status(400).json({ error: 'New passcode must be at least 4 characters.' });
        }

        if (newPasscode === currentPasscode) {
            return res.status(400).json({ error: 'New passcode must be different from the current one.' });
        }

        await saveAdminPasscode(newPasscode);
        return res.status(200).json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
