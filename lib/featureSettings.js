// lib/featureSettings.js
//
// Resolves/saves the admin-controlled feature settings from /adminaccount
// (Feature Access view). Stored as one document in the MongoDB "settings"
// collection (_id: "feature_settings").
//
// Shape:
//   {
//     addAccountAccess: {
//       mode: 'off' | 'all' | 'specific',
//       allowedAccountIds: string[]   // only used when mode === 'specific'
//     },
//     sessionSettings: {
//       mode: 'timeout' | 'never',
//       timeoutMinutes: number,       // only used when mode === 'timeout'
//       persistAcrossTabClose: boolean
//     }
//   }
//
// Not placed under /api so it isn't picked up as its own serverless function.

import { getSetting, saveSetting } from './settings.js';

const SETTING_KEY = 'feature_settings';

const DEFAULT_SETTINGS = {
    addAccountAccess: {
        mode: 'off',
        allowedAccountIds: []
    },
    sessionSettings: {
        mode: 'timeout',
        timeoutMinutes: 2,
        persistAcrossTabClose: false
    }
};

function normalizeSessionSettings(raw) {
    const mode = raw && raw.mode === 'never' ? 'never' : 'timeout';
    const minutes = raw ? Number(raw.timeoutMinutes) : NaN;
    return {
        mode,
        timeoutMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_SETTINGS.sessionSettings.timeoutMinutes,
        persistAcrossTabClose: !!(raw && raw.persistAcrossTabClose)
    };
}

export async function getFeatureSettings() {
    try {
        const data = await getSetting(SETTING_KEY);
        if (!data) return DEFAULT_SETTINGS;

        return {
            addAccountAccess: {
                mode: (data.addAccountAccess && data.addAccountAccess.mode) || 'off',
                allowedAccountIds: (data.addAccountAccess && Array.isArray(data.addAccountAccess.allowedAccountIds))
                    ? data.addAccountAccess.allowedAccountIds
                    : []
            },
            sessionSettings: normalizeSessionSettings(data.sessionSettings)
        };
    } catch (err) {
        console.error('Failed to load feature settings from MongoDB:', err);
        return DEFAULT_SETTINGS; // fail safe: feature stays hidden if settings can't be read
    }
}

export async function saveFeatureSettings(settings) {
    return saveSetting(SETTING_KEY, settings);
}

// Given the logged-in account (resolved from the session token, or null) and
// the feature settings, resolves whether the "Add Account" self-service link
// should be visible to them. Requires a valid login in every mode.
export function resolveAddAccountVisibility(settings, account) {
    if (!account) return false;

    const mode = settings?.addAccountAccess?.mode || 'off';

    if (mode === 'off') return false;
    if (mode === 'all') return true;

    if (mode === 'specific') {
        const allowed = settings.addAccountAccess.allowedAccountIds || [];
        return allowed.includes(account.id);
    }

    return false;
}
