// lib/driveConfig.js
//
// Works out how an account reaches its Drive and what the browser needs to know.
//
//   mode "script"  - older accounts that use their own Google Apps Script
//                    (macroUrl + rootFolderId stored on the account)
//   mode "google"  - Google account connected; the browser talks to the Drive
//                    API through the in-browser bridge using short-lived tokens
//   mode "pending" - no Drive connected yet; the dashboard shows "Connect"

export const BRIDGE_URL = 'drivesync-bridge://drive';
export const PENDING_ROOT = 'pending';

export function driveModeOf(account) {
    if (account.driveRefreshToken) return 'google';
    if (account.macroUrl && account.rootFolderId) return 'script';
    return 'pending';
}

export function driveConfigFor(account) {
    const mode = driveModeOf(account);
    if (mode === 'script') {
        return { driveMode: mode, macroUrl: account.macroUrl, rootFolderId: account.rootFolderId };
    }
    return {
        driveMode: mode,
        macroUrl: BRIDGE_URL,
        rootFolderId: mode === 'google' ? account.rootFolderId : PENDING_ROOT,
        driveEmail: account.googleEmail || ''
    };
}

// The account fields the browser may see (never the password hash or tokens).
export function accountForBrowser(account) {
    return {
        email: account.email,
        label: account.label,
        avatar: account.avatar || '',
        hasPassword: Boolean(account.passwordHash),
        googleLinked: Boolean(account.googleId),
        isStatic: Boolean(account.isStatic)
    };
}
