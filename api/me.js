// api/me.js
//
// GET with "Authorization: Bearer <token>" → confirms the session is still
// valid (token not expired, account still exists, password not changed since)
// and returns the account's current Drive config. Used when restoring a
// persisted login so a changed password / deleted account is picked up.

import { getSessionAccount } from '../lib/session.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const account = await getSessionAccount(req);
        if (!account) return res.status(401).json({ authenticated: false, error: 'Session expired. Please log in again.' });

        return res.status(200).json({
            authenticated: true,
            account: { email: account.email, label: account.label },
            config: { macroUrl: account.macroUrl, rootFolderId: account.rootFolderId }
        });
    } catch (err) {
        console.error('me.js crashed:', err);
        return res.status(500).json({ error: 'Internal server error.' });
    }
}
