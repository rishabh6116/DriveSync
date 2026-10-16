// api/self-add-account.js
//
// Powers the "Add Account" link shown inside the app sidebar, which lets an
// already-logged-in user register a brand new drive account themselves,
// without going through /admin.html.
//
// Whether this link/feature is available at all is controlled by the admin
// from the "Feature Access" view in /admin.html (off / all users / specific
// users) — see lib/featureSettings.js. Both GET (visibility check) and POST
// (actually creating the account) re-validate against that setting, since
// the GET is only used to decide whether to show the UI and isn't a
// security boundary by itself.
//
// The requester is identified by their session token ("Authorization: Bearer").

import { DuplicateEmailError, emailUsedByStaticAccount, insertAccount } from '../lib/accounts.js';
import { getFeatureSettings, resolveAddAccountVisibility } from '../lib/featureSettings.js';
import { hashPassword, normalizeEmail, validateEmail, validatePassword } from '../lib/passwords.js';
import { getSessionAccount } from '../lib/session.js';

export default async function handler(req, res) {
    if (req.method === 'GET') {
        try {
            const [settings, requester] = await Promise.all([getFeatureSettings(), getSessionAccount(req)]);
            return res.status(200).json({ visible: resolveAddAccountVisibility(settings, requester) });
        } catch (err) {
            return res.status(500).json({ visible: false, error: err.message });
        }
    }

    if (req.method === 'POST') {
        const { label, email, password, macroUrl, rootFolderId } = req.body || {};
        const cleanEmail = normalizeEmail(email);

        if (!label || !cleanEmail || !password || !macroUrl || !rootFolderId) {
            return res.status(400).json({ error: 'label, email, password, macroUrl, and rootFolderId are all required.' });
        }

        const problem = validateEmail(cleanEmail) || validatePassword(password);
        if (problem) return res.status(400).json({ error: problem });

        try {
            const [settings, requester] = await Promise.all([getFeatureSettings(), getSessionAccount(req)]);

            if (!resolveAddAccountVisibility(settings, requester)) {
                return res.status(403).json({ error: 'This feature is not available for your account right now.' });
            }

            if (emailUsedByStaticAccount(cleanEmail)) {
                return res.status(409).json({ error: 'An account with that email already exists.' });
            }

            const newAccount = {
                id: `acct_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                label,
                email: cleanEmail,
                passwordHash: await hashPassword(password),
                macroUrl,
                rootFolderId,
                createdAt: new Date().toISOString(),
                addedBy: 'self-service'
            };

            await insertAccount(newAccount);
            return res.status(201).json({ success: true, account: { id: newAccount.id, label: newAccount.label } });
        } catch (err) {
            if (err instanceof DuplicateEmailError) return res.status(409).json({ error: err.message });
            return res.status(500).json({ error: err.message });
        }
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
}
