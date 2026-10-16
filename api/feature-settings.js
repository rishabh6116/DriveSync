// api/feature-settings.js
//
// Admin endpoint used by /admin.html (Feature Access view) to read and
// update the "Add Account" self-service toggle. Protected by the admin
// passcode (sent as an "x-admin-passcode" header), same as /api/admin-accounts.

import { isValidAdminPasscode } from '../lib/adminAuth.js';
import { getFeatureSettings, saveFeatureSettings } from '../lib/featureSettings.js';

const isAdmin = (req) => isValidAdminPasscode(req.headers['x-admin-passcode']);

const VALID_MODES = ['off', 'all', 'specific'];
const VALID_SESSION_MODES = ['timeout', 'never'];

export default async function handler(req, res) {
    if (!(await isAdmin(req))) {
        return res.status(401).json({ error: 'Invalid admin passcode.' });
    }

    if (req.method === 'GET') {
        try {
            const settings = await getFeatureSettings();
            return res.status(200).json({ settings });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    if (req.method === 'PUT') {
        // Body can update either (or both) settings groups independently:
        //   { addAccountAccess: { mode, allowedAccountIds } }
        //   { sessionSettings: { mode, timeoutMinutes, persistAcrossTabClose } }
        // Also accepts the legacy flat shape { mode, allowedAccountIds } for
        // addAccountAccess, kept for backwards compatibility.
        const body = req.body || {};
        const addAccountAccess = body.addAccountAccess || (body.mode && VALID_MODES.includes(body.mode) ? body : null);
        const sessionSettings = body.sessionSettings || null;

        if (!addAccountAccess && !sessionSettings) {
            return res.status(400).json({ error: 'No settings provided to update.' });
        }

        try {
            const current = await getFeatureSettings();
            const updated = { ...current };

            if (addAccountAccess) {
                const { mode, allowedAccountIds } = addAccountAccess;
                if (!VALID_MODES.includes(mode)) {
                    return res.status(400).json({ error: `mode must be one of: ${VALID_MODES.join(', ')}` });
                }
                updated.addAccountAccess = {
                    mode,
                    allowedAccountIds: Array.isArray(allowedAccountIds) ? allowedAccountIds : []
                };
            }

            if (sessionSettings) {
                const { mode, timeoutMinutes, persistAcrossTabClose } = sessionSettings;
                if (!VALID_SESSION_MODES.includes(mode)) {
                    return res.status(400).json({ error: `mode must be one of: ${VALID_SESSION_MODES.join(', ')}` });
                }
                const minutes = Number(timeoutMinutes);
                if (mode === 'timeout' && (!Number.isFinite(minutes) || minutes <= 0)) {
                    return res.status(400).json({ error: 'timeoutMinutes must be a positive number when mode is "timeout".' });
                }
                updated.sessionSettings = {
                    mode,
                    timeoutMinutes: mode === 'timeout' ? minutes : current.sessionSettings.timeoutMinutes,
                    persistAcrossTabClose: !!persistAcrossTabClose
                };
            }

            await saveFeatureSettings(updated);
            return res.status(200).json({ success: true, settings: updated });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
}
