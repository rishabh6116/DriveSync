// api/admin-accounts.js
//
// Admin endpoint used by /adminaccount to list, add, edit, and delete
// accounts. Protected by the admin passcode (sent as an "x-admin-passcode"
// header). Accounts are stored in the MongoDB "accounts" collection.
//
// Accounts log in with email + password. Passwords are stored only as scrypt
// hashes and are never returned.

import {
    DuplicateEmailError, deleteAccount, emailUsedByStaticAccount, findDynamicById,
    getDynamicAccounts, insertAccount, publicAccount, updateAccount
} from '../lib/accounts.js';
import { isValidAdminPasscode } from '../lib/adminAuth.js';
import { hashPassword, normalizeEmail, validateEmail, validatePassword } from '../lib/passwords.js';

const isAdmin = (req) => isValidAdminPasscode(req.headers['x-admin-passcode']);

export default async function handler(req, res) {
    if (!(await isAdmin(req))) {
        return res.status(401).json({ error: 'Invalid admin passcode.' });
    }

    const id = (req.query && req.query.id) || (new URL(req.url, 'http://x').searchParams.get('id'));

    try {
        if (req.method === 'GET') {
            if (id) {
                const match = await findDynamicById(id);
                if (!match) return res.status(404).json({ error: 'Account not found.' });
                return res.status(200).json({ account: publicAccount(match) });
            }

            const accounts = await getDynamicAccounts();
            return res.status(200).json({ accounts: accounts.map(publicAccount) });
        }

        if (req.method === 'POST') {
            const { label, email, password, macroUrl, rootFolderId } = req.body || {};
            const cleanEmail = normalizeEmail(email);

            if (!label || !cleanEmail || !password || !macroUrl || !rootFolderId) {
                return res.status(400).json({ error: 'label, email, password, macroUrl, and rootFolderId are all required.' });
            }

            const problem = validateEmail(cleanEmail) || validatePassword(password);
            if (problem) return res.status(400).json({ error: problem });

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
                createdAt: new Date().toISOString()
            };

            await insertAccount(newAccount);
            return res.status(201).json({ success: true, account: { id: newAccount.id, label: newAccount.label } });
        }

        if (req.method === 'PUT') {
            const { label, email, password, macroUrl, rootFolderId } = req.body || {};
            const cleanEmail = normalizeEmail(email);

            if (!id) {
                return res.status(400).json({ error: 'id query param is required.' });
            }
            if (!label || !cleanEmail || !macroUrl || !rootFolderId) {
                return res.status(400).json({ error: 'label, email, macroUrl, and rootFolderId are required.' });
            }

            const emailProblem = validateEmail(cleanEmail);
            if (emailProblem) return res.status(400).json({ error: emailProblem });

            // Password is optional on edit (blank = keep the current one).
            if (password) {
                const pwProblem = validatePassword(password);
                if (pwProblem) return res.status(400).json({ error: pwProblem });
            }

            if (emailUsedByStaticAccount(cleanEmail)) {
                return res.status(409).json({ error: 'An account with that email already exists.' });
            }

            const updated = await updateAccount(id, {
                label,
                email: cleanEmail,
                ...(password ? { passwordHash: await hashPassword(password) } : {}),
                macroUrl,
                rootFolderId,
                updatedAt: new Date().toISOString()
            });

            if (!updated) return res.status(404).json({ error: 'Account not found.' });
            return res.status(200).json({ success: true, account: { id, label } });
        }

        if (req.method === 'DELETE') {
            if (!id) {
                return res.status(400).json({ error: 'id query param is required.' });
            }

            const deleted = await deleteAccount(id);
            if (!deleted) return res.status(404).json({ error: 'Account not found.' });
            return res.status(200).json({ success: true });
        }

        return res.status(405).json({ error: 'Method Not Allowed' });
    } catch (err) {
        if (err instanceof DuplicateEmailError) return res.status(409).json({ error: err.message });
        return res.status(500).json({ error: err.message });
    }
}
