// src/lib/rememberedAccount.js
//
// Remembers the accounts that have signed in on THIS browser (name + profile
// photo + email) so the sign-in / forgot / reset pages can show the returning
// user's photo instead of the default DriveSync logo.
//
// Stored in localStorage on the device only; it survives logout on purpose.
// Passwords and tokens are never stored here.

const KEY = 'drivesync_known_accounts';
const MAX_ACCOUNTS = 5;
const AVATAR_RE = /^data:image\/jpeg;base64,/;

function read() {
    try {
        const list = JSON.parse(localStorage.getItem(KEY) || '[]');
        return Array.isArray(list) ? list.filter((a) => a && a.email) : [];
    } catch (err) {
        return [];
    }
}

function write(list) {
    try {
        localStorage.setItem(KEY, JSON.stringify(list));
    } catch (err) {
        // Storage full / blocked: skip, the default logo simply stays.
    }
}

export function rememberAccount(account) {
    if (!account || !account.email) return;
    const email = String(account.email).trim().toLowerCase();
    const avatar = AVATAR_RE.test(account.avatar || '') ? account.avatar : '';
    const rest = read().filter((a) => a.email !== email);
    rest.unshift({ email, label: String(account.label || ''), avatar, ts: Date.now() });
    write(rest.slice(0, MAX_ACCOUNTS));
    syncFavicon();
}

// Most recently signed-in account that has a photo (or null).
export function getLastAccount() {
    return read().find((a) => AVATAR_RE.test(a.avatar || '')) || null;
}

export function getAccountByEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    if (!e) return null;
    return read().find((a) => a.email === e && AVATAR_RE.test(a.avatar || '')) || null;
}

export function getLastAvatar() {
    const a = getLastAccount();
    return a ? a.avatar : '';
}

// ---------------------------------------------------------------------------
// Browser-tab favicon: use the remembered account's photo (cropped to a circle)
// instead of the default DriveSync icon. Falls back to the original icons when
// no remembered photo exists.
// ---------------------------------------------------------------------------
const ICON_SELECTOR = 'link[rel~="icon"], link[rel="apple-touch-icon"]';
let originalIcons = null;
let faviconToken = 0;

function roundedPng(dataUrl, size) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = size;
                const ctx = canvas.getContext('2d');
                ctx.beginPath();
                ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
                ctx.closePath();
                ctx.clip();
                const side = Math.min(img.naturalWidth, img.naturalHeight);
                const sx = (img.naturalWidth - side) / 2;
                const sy = (img.naturalHeight - side) / 2;
                ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
                resolve(canvas.toDataURL('image/png'));
            } catch (err) {
                resolve(dataUrl);
            }
        };
        img.onerror = () => resolve('');
        img.src = dataUrl;
    });
}

function setIconLinks(links) {
    document.querySelectorAll(ICON_SELECTOR).forEach((el) => el.remove());
    links.forEach((el) => document.head.appendChild(el));
}

function makeLink(rel, href, extra) {
    const el = document.createElement('link');
    el.rel = rel;
    el.href = href;
    Object.keys(extra || {}).forEach((k) => el.setAttribute(k, extra[k]));
    return el;
}

export async function applyFavicon(avatar) {
    if (typeof document === 'undefined') return;
    if (!originalIcons) {
        originalIcons = Array.from(document.querySelectorAll(ICON_SELECTOR)).map((el) => el.cloneNode(true));
    }
    const token = ++faviconToken;

    if (!AVATAR_RE.test(avatar || '')) {
        if (originalIcons.length) setIconLinks(originalIcons.map((el) => el.cloneNode(true)));
        return;
    }

    const png = await roundedPng(avatar, 128);
    if (token !== faviconToken) return; // a newer call superseded this one
    if (!png) return;
    setIconLinks([
        makeLink('icon', png, { type: 'image/png' }),
        makeLink('apple-touch-icon', png),
    ]);
}

export function syncFavicon() {
    return applyFavicon(getLastAvatar());
}
