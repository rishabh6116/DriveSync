// api/session-settings.js
//
// Public, read-only endpoint that exposes the auto-logout / session-timeout
// setting controlled by the admin from /admin.html (Feature Access view).
//
// This is intentionally NOT behind the admin passcode — it's read by every
// unlocked app tab (see setupIdleTimer() in IndexPage.script.js /
// ThemePage.script.js) to decide how the idle timer should behave. It isn't
// a security boundary by itself, same as /api/self-add-account's GET.

import { getFeatureSettings } from '../lib/featureSettings.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const settings = await getFeatureSettings();
        return res.status(200).json(settings.sessionSettings);
    } catch (err) {
        // Fail safe: if we can't read the setting, fall back to a short
        // timeout rather than accidentally leaving sessions open forever.
        return res.status(200).json({ mode: 'timeout', timeoutMinutes: 2, persistAcrossTabClose: false });
    }
}
