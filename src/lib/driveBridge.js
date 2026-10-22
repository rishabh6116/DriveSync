// In-browser "Drive bridge".
//
// The dashboard was written to talk to a Google Apps Script web app using
// fetch(macroUrl + "?action=...") / fetch(macroUrl, { method: "POST", body }).
// For accounts connected with Google, `macroUrl` is the special value
// BRIDGE_URL below. installDriveBridge() wraps window.fetch so that any request
// to BRIDGE_URL is answered by this file instead: it performs the same actions
// directly against the Google Drive API using a short-lived access token that
// the server hands out (/api/me?drive=token). The long-lived refresh token never
// reaches the browser. The full `drive` scope lets DriveSync list files that
// were added to the DriveSync folder by hand in Google Drive too.
//
// Because the replies have exactly the same JSON shape as the Apps Script ones,
// none of the existing dashboard code (browse, upload, rename, delete, notes,
// folder sync, search) needed to change.

export const BRIDGE_URL = 'drivesync-bridge://drive';
export const PENDING_ROOT = 'pending';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,mimeType,size,webViewLink,modifiedTime';
const MULTIPART_LIMIT = 4 * 1024 * 1024; // above this, use a resumable upload

export const NEEDS_CONNECT_EVENT = 'drivesync:needs-connect';

let nativeFetch = null;
let tokenCache = null; // { token, expiresAt }

class BridgeError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

// ---------------------------------------------------------------------------
// Access token (cached until a minute before it expires)
// ---------------------------------------------------------------------------
export function clearBridgeToken() {
    tokenCache = null;
}

async function getAccessToken(force = false) {
    if (!force && tokenCache && tokenCache.expiresAt - 60000 > Date.now()) return tokenCache.token;

    const session = sessionStorage.getItem('drivesync_token') || localStorage.getItem('drivesync_token') || '';
    const resp = await nativeFetch('/api/me?drive=token', { headers: { Authorization: `Bearer ${session}` } });
    let data = {};
    try { data = await resp.json(); } catch { /* handled below */ }

    if (resp.status === 409 || data.needsConnect) {
        window.dispatchEvent(new CustomEvent(NEEDS_CONNECT_EVENT));
        throw new BridgeError(data.error || 'Google Drive is not connected yet.', 'NOT_CONNECTED');
    }
    if (!resp.ok || !data.accessToken) {
        throw new BridgeError(data.error || 'Could not get access to Google Drive.', 'TOKEN');
    }
    tokenCache = { token: data.accessToken, expiresAt: Date.now() + (data.expiresIn || 3600) * 1000 };
    return tokenCache.token;
}

// Calls Google with the bearer token; retries once with a fresh token on 401.
async function google(url, init = {}, retry = true) {
    const token = await getAccessToken(!retry);
    const resp = await nativeFetch(url, {
        ...init,
        headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` }
    });
    if (resp.status === 401 && retry) return google(url, init, false);
    if (!resp.ok) {
        let message = `Google Drive error (${resp.status})`;
        try { message = (await resp.clone().json()).error?.message || message; } catch { /* keep default */ }
        if (resp.status === 404) message = 'That file or folder was not found in your Google Drive.';
        throw new BridgeError(message, `HTTP_${resp.status}`);
    }
    return resp;
}

const googleJson = async (url, init) => (await google(url, init)).json();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const rootId = () => sessionStorage.getItem('drivesync_root') || localStorage.getItem('drivesync_root') || '';

function safeId(id) {
    const v = String(id || '');
    if (!/^[A-Za-z0-9_-]+$/.test(v)) throw new BridgeError('Invalid file or folder id.', 'BAD_ID');
    return v;
}

const toMs = (iso) => (iso ? Date.parse(iso) || 0 : 0);

function mapItem(f) {
    const isFolder = f.mimeType === FOLDER_MIME;
    return {
        id: f.id,
        name: f.name,
        type: isFolder ? 'folder' : f.mimeType,
        size: isFolder ? 0 : Number(f.size || 0),
        url: f.webViewLink || '',
        modifiedTime: toMs(f.modifiedTime)
    };
}

function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

async function base64ToBlob(b64, mime) {
    // A data: URL decodes large payloads far faster than a JS loop.
    const resp = await nativeFetch(`data:${mime || 'application/octet-stream'};base64,${b64}`);
    return resp.blob();
}

// ---------------------------------------------------------------------------
// Actions (same names as backend/Code.gs)
// ---------------------------------------------------------------------------
async function listChildren(folderId) {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const items = [];
    let pageToken = '';
    do {
        const url = `${DRIVE}/files?q=${q}&pageSize=1000&fields=nextPageToken,files(${FILE_FIELDS})` +
            `&orderBy=folder,name${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
        const data = await googleJson(url);
        items.push(...(data.files || []).map(mapItem));
        pageToken = data.nextPageToken || '';
    } while (pageToken);
    return items;
}

async function fetchItems(p) {
    const root = rootId();
    if (!root || root === PENDING_ROOT) throw new BridgeError('Google Drive is not connected yet.', 'NOT_CONNECTED');
    const folderId = safeId(p.folderId || root);

    const items = await listChildren(folderId);

    let parentFolderId = null;
    if (folderId !== root) {
        const meta = await googleJson(`${DRIVE}/files/${folderId}?fields=parents`);
        parentFolderId = (meta.parents && meta.parents[0]) || null;
    }
    return { result: 'success', currentFolderId: folderId, parentFolderId, items };
}

async function getStorageInfo() {
    const data = await googleJson(`${DRIVE}/about?fields=storageQuota`);
    const GB = 1024 * 1024 * 1024;
    const q = data.storageQuota || {};
    return {
        result: 'success',
        storageUsed: (Number(q.usage || 0) / GB).toFixed(1),
        storageTotal: q.limit ? (Number(q.limit) / GB).toFixed(0) : '0'
    };
}

// Real id of the user's "My Drive" root (used by the Full Drive view).
async function getRootId() {
    const data = await googleJson(`${DRIVE}/files/root?fields=id`);
    return { result: 'success', id: data.id };
}

async function downloadFile(p) {
    const id = safeId(p.fileId);
    const meta = await googleJson(`${DRIVE}/files/${id}?fields=${FILE_FIELDS}`);
    const resp = await google(`${DRIVE}/files/${id}?alt=media`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    return {
        result: 'success',
        fileData: bytesToBase64(bytes),
        mimeType: meta.mimeType,
        fileName: meta.name,
        size: Number(meta.size || bytes.length),
        modifiedTime: toMs(meta.modifiedTime)
    };
}

async function createFolder(p) {
    const name = String(p.folderName || '').trim();
    if (!name) throw new BridgeError('Folder name cannot be empty.', 'BAD_NAME');
    const parent = safeId(p.parentFolderId || rootId());
    const data = await googleJson(`${DRIVE}/files?fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] })
    });
    return { result: 'success', id: data.id, folderId: data.id };
}

async function patchFile(id, body, fields = 'id,name,modifiedTime') {
    return googleJson(`${DRIVE}/files/${safeId(id)}?fields=${fields}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

async function deleteItem(p) {
    await patchFile(p.itemId, { trashed: true }, 'id');
    return { result: 'success' };
}

async function renameItem(p) {
    const newName = String(p.newName || '').trim();
    if (!newName) return { result: 'error', message: 'New name cannot be empty.' };
    const data = await patchFile(p.itemId, { name: newName });
    return { result: 'success', id: data.id, name: data.name, modifiedTime: toMs(data.modifiedTime) };
}

async function updateTextFile(p) {
    const id = safeId(p.fileId);
    await google(`${UPLOAD}/files/${id}?uploadType=media&fields=id`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
        body: new Blob([p.content || ''], { type: 'text/plain' })
    });
    let data = { id };
    if (p.fileName) {
        data = await patchFile(id, { name: p.fileName });
    } else {
        data = await googleJson(`${DRIVE}/files/${id}?fields=id,name,modifiedTime`);
    }
    return { result: 'success', id: data.id, name: data.name, modifiedTime: toMs(data.modifiedTime) };
}

async function uploadFile(p) {
    const parent = safeId(p.targetFolderId || rootId());
    const mime = p.mimeType || 'application/octet-stream';
    const blob = await base64ToBlob(p.fileData, mime);
    const metadata = { name: p.fileName || 'Untitled', parents: [parent], mimeType: mime };

    let file;
    if (blob.size <= MULTIPART_LIMIT) {
        const boundary = `drivesync${Math.random().toString(36).slice(2)}`;
        const body = new Blob([
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
            `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
            blob,
            `\r\n--${boundary}--`
        ]);
        file = await googleJson(`${UPLOAD}/files?uploadType=multipart&fields=${FILE_FIELDS}`, {
            method: 'POST',
            headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
            body
        });
    } else {
        const init = await google(`${UPLOAD}/files?uploadType=resumable&fields=${FILE_FIELDS}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime },
            body: JSON.stringify(metadata)
        });
        const sessionUrl = init.headers.get('Location');
        if (!sessionUrl) throw new BridgeError('Google did not start the upload.', 'UPLOAD');
        const done = await nativeFetch(sessionUrl, { method: 'PUT', headers: { 'Content-Type': mime }, body: blob });
        if (!done.ok) throw new BridgeError(`Upload failed (${done.status}).`, 'UPLOAD');
        file = await done.json();
    }

    // The dashboard previews images/PDFs through Google's public thumbnail and
    // embed endpoints, which need "anyone with the link can view" (this is what
    // the Apps Script version did too). Best effort: some Workspace accounts
    // forbid link sharing, and the upload itself has already succeeded.
    try {
        await google(`${DRIVE}/files/${file.id}/permissions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'reader', type: 'anyone' })
        });
    } catch { /* ignore */ }

    return { result: 'success', ...mapItem(file), type: file.mimeType, fileId: file.id };
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------
function readParams(url, init) {
    const params = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '');
    const body = init && init.body;
    if (body instanceof URLSearchParams) body.forEach((v, k) => params.set(k, v));
    else if (typeof body === 'string') new URLSearchParams(body).forEach((v, k) => params.set(k, v));
    else if (typeof FormData !== 'undefined' && body instanceof FormData) body.forEach((v, k) => params.set(k, String(v)));
    return Object.fromEntries(params.entries());
}

async function handle(url, init) {
    const method = String((init && init.method) || 'GET').toUpperCase();
    const p = readParams(url, init);

    if (method === 'GET') {
        if (p.action === 'fetchItems' || p.action === 'list') return fetchItems(p);
        if (p.action === 'getStorageInfo') return getStorageInfo();
        if (p.action === 'downloadFile') return downloadFile(p);
        if (p.action === 'getRootId') return getRootId();
        return { result: 'success', message: 'DriveSync Drive bridge is active.' };
    }

    if (p.action === 'createFolder') return createFolder(p);
    if (p.action === 'deleteItem') return deleteItem(p);
    if (p.action === 'renameItem') return renameItem(p);
    if (p.action === 'updateTextFile') return updateTextFile(p);
    if (p.fileData !== undefined) return uploadFile(p);
    return { result: 'error', message: 'Unknown action.' };
}

export async function bridgeRequest(url, init) {
    try {
        return await handle(url, init);
    } catch (err) {
        return { result: 'error', message: err.message || String(err), code: err.code || 'ERROR' };
    }
}

const isBridgeUrl = (input) => typeof input === 'string' && input.startsWith(BRIDGE_URL);

// Wraps window.fetch once. Requests to BRIDGE_URL are answered locally.
export function installDriveBridge(target = window) {
    if (target.__drivesyncBridgeInstalled) return;
    nativeFetch = target.fetch.bind(target);
    target.fetch = (input, init) => {
        if (!isBridgeUrl(input)) return nativeFetch(input, init);
        return bridgeRequest(input, init).then(
            (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
        );
    };
    target.__drivesyncBridgeInstalled = true;
}

// Test hook: lets unit tests supply their own "native" fetch.
export function __setNativeFetchForTests(fn) {
    nativeFetch = fn;
    tokenCache = null;
}
