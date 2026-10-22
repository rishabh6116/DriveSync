import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal browser stand-ins
const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
globalThis.sessionStorage = store();
globalThis.localStorage = store();
const events = [];
globalThis.window = { dispatchEvent: (e) => events.push(e.type) };

const { bridgeRequest, installDriveBridge, __setNativeFetchForTests, BRIDGE_URL, NEEDS_CONNECT_EVENT } = await import('../src/lib/driveBridge.js');

const ROOT = 'RootFolder1234567890';
let log, tokenStatus, driveFail401Once, files;

const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function fakeNative(url, init = {}) {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    log.push(`${method} ${u.replace('https://www.googleapis.com', '')}`);

    if (u.startsWith('/api/me?drive=token')) {
        if (tokenStatus === 409) return json({ needsConnect: true, error: 'not connected' }, 409);
        return json({ accessToken: 'tok-' + log.length, expiresIn: 3600 });
    }
    if (u.startsWith('data:')) return fetch(u); // real data: URL decoding

    if (driveFail401Once && u.includes('googleapis')) { driveFail401Once = false; return json({ error: { message: 'expired' } }, 401); }

    if (u.includes('/upload/drive/v3/files?uploadType=multipart')) {
        files.lastMultipart = init.body;
        return json({ id: 'newfile1', name: 'a.txt', mimeType: 'text/plain', size: '5', webViewLink: 'https://drive/x', modifiedTime: '2026-01-02T03:04:05.000Z' });
    }
    if (u.includes('uploadType=resumable')) return new Response('{}', { status: 200, headers: { Location: 'https://upload.test/session1' } });
    if (u === 'https://upload.test/session1') return json({ id: 'bigfile1', name: 'big.bin', mimeType: 'application/octet-stream', size: String(init.body.size), webViewLink: 'u', modifiedTime: '2026-01-02T00:00:00.000Z' });
    if (u.includes('uploadType=media')) return json({ id: 'note1' });
    if (u.includes('/permissions')) return json({ id: 'perm' });
    if (u.includes('/about')) return json({ storageQuota: { usage: String(3 * 1024 ** 3), limit: String(15 * 1024 ** 3) } });
    if (u.includes('alt=media')) return new Response(new TextEncoder().encode('hello note'), { status: 200 });
    if (method === 'GET' && u.includes('/files?q=')) {
        const q = decodeURIComponent(u.split('q=')[1].split('&')[0]);
        const parent = q.match(/'([^']+)' in parents/)[1];
        return json({ files: files.byParent[parent] || [] });
    }
    if (method === 'GET' && u.includes('fields=parents')) return json({ parents: [ROOT] });
    if (method === 'GET' && u.includes('fields=id,name,mimeType,size')) return json({ id: 'note1', name: 'My note.txt', mimeType: 'text/plain', size: '10', modifiedTime: '2026-03-01T00:00:00.000Z' });
    if (method === 'GET' && u.includes('fields=id,name,modifiedTime')) return json({ id: 'note1', name: 'My note.txt', modifiedTime: '2026-03-01T00:00:00.000Z' });
    if (method === 'POST' && u.includes('/drive/v3/files?fields=id')) { files.lastCreate = JSON.parse(init.body); return json({ id: 'folder-new' }); }
    if (method === 'PATCH') { files.lastPatch = JSON.parse(init.body); return json({ id: 'item1', name: files.lastPatch.name || 'x', modifiedTime: '2026-02-02T00:00:00.000Z' }); }
    return json({ error: { message: 'unhandled ' + u } }, 500);
}

beforeEach(() => {
    log = []; tokenStatus = 200; driveFail401Once = false; events.length = 0;
    files = { byParent: {
        [ROOT]: [
            { id: 'f1', name: 'Docs', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-01-01T00:00:00.000Z' },
            { id: 'p1', name: 'pic.png', mimeType: 'image/png', size: '2048', webViewLink: 'https://drive/pic', modifiedTime: '2026-01-05T00:00:00.000Z' }
        ],
        f1: []
    } };
    sessionStorage.setItem('drivesync_root', ROOT);
    sessionStorage.setItem('drivesync_token', 'session-token');
    __setNativeFetchForTests(fakeNative);
});

const get = (params) => bridgeRequest(`${BRIDGE_URL}?${new URLSearchParams(params)}`, undefined);
const post = (params) => bridgeRequest(BRIDGE_URL, { method: 'POST', body: new URLSearchParams(params) });

test('fetchItems returns the Apps-Script-shaped list (folders typed "folder", times in ms)', async () => {
    const r = await get({ action: 'fetchItems', folderId: ROOT });
    assert.equal(r.result, 'success');
    assert.equal(r.parentFolderId, null);
    assert.deepEqual(r.items[0], { id: 'f1', name: 'Docs', type: 'folder', size: 0, url: '', modifiedTime: Date.parse('2026-01-01T00:00:00.000Z') });
    assert.equal(r.items[1].type, 'image/png');
    assert.equal(r.items[1].size, 2048);
    assert.equal(typeof r.items[1].modifiedTime, 'number');
});

test('a sub-folder reports its parent; default folder is the root', async () => {
    const sub = await get({ action: 'fetchItems', folderId: 'f1' });
    assert.equal(sub.parentFolderId, ROOT);
    const def = await get({ action: 'fetchItems' });
    assert.equal(def.currentFolderId, ROOT);
});

test('access token is cached across calls', async () => {
    await get({ action: 'fetchItems' });
    await get({ action: 'fetchItems' });
    assert.equal(log.filter((l) => l.includes('/api/me?drive=token')).length, 1);
});

test('a 401 from Google triggers one token refresh and a retry', async () => {
    driveFail401Once = true;
    const r = await get({ action: 'fetchItems' });
    assert.equal(r.result, 'success');
    assert.equal(log.filter((l) => l.includes('/api/me?drive=token')).length, 2);
});

test('not connected: error result + needs-connect event, no Drive calls', async () => {
    tokenStatus = 409;
    const r = await get({ action: 'fetchItems' });
    assert.equal(r.result, 'error');
    assert.equal(r.code, 'NOT_CONNECTED');
    assert.ok(events.includes(NEEDS_CONNECT_EVENT));
    sessionStorage.setItem('drivesync_root', 'pending');
    const p = await get({ action: 'fetchItems' });
    assert.equal(p.code, 'NOT_CONNECTED');
});

test('createFolder / renameItem / deleteItem', async () => {
    const c = await post({ action: 'createFolder', folderName: 'Trips', parentFolderId: ROOT });
    assert.deepEqual([c.result, c.id, c.folderId], ['success', 'folder-new', 'folder-new']);
    assert.deepEqual(files.lastCreate, { name: 'Trips', mimeType: 'application/vnd.google-apps.folder', parents: [ROOT] });

    const r = await post({ action: 'renameItem', itemId: 'item1', itemType: 'file', newName: ' New name ' });
    assert.equal(r.result, 'success');
    assert.equal(files.lastPatch.name, 'New name');
    assert.equal((await post({ action: 'renameItem', itemId: 'item1', newName: '  ' })).result, 'error');

    const d = await post({ action: 'deleteItem', itemId: 'item1', itemType: 'folder' });
    assert.equal(d.result, 'success');
    assert.deepEqual(files.lastPatch, { trashed: true });
});

test('ids are validated before being put into a URL', async () => {
    const r = await post({ action: 'deleteItem', itemId: '../about?x=1', itemType: 'file' });
    assert.equal(r.result, 'error');
    assert.ok(!log.some((l) => l.includes('about?x=1')));
});

test('small upload = multipart, made "anyone with link", returns the new file', async () => {
    const r = await post({ fileData: Buffer.from('hello').toString('base64'), mimeType: 'text/plain', fileName: 'a.txt', targetFolderId: ROOT });
    assert.equal(r.result, 'success');
    assert.equal(r.id, 'newfile1');
    assert.equal(r.size, 5);
    assert.ok(log.some((l) => l.startsWith('POST') && l.includes('/files/newfile1/permissions')));
    const body = await files.lastMultipart.text();
    assert.ok(body.includes('"parents":["' + ROOT + '"]') && body.includes('hello'));
});

test('large upload (>4 MB) uses a resumable session', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024, 1).toString('base64');
    const r = await post({ fileData: big, mimeType: 'application/octet-stream', fileName: 'big.bin', targetFolderId: ROOT });
    assert.equal(r.result, 'success');
    assert.equal(r.id, 'bigfile1');
    assert.equal(r.size, 5 * 1024 * 1024);
    assert.ok(log.some((l) => l.includes('uploadType=resumable')));
});

test('notes: downloadFile + updateTextFile', async () => {
    const dl = await get({ action: 'downloadFile', fileId: 'note1' });
    assert.equal(Buffer.from(dl.fileData, 'base64').toString(), 'hello note');
    assert.equal(dl.fileName, 'My note.txt');
    const up = await post({ action: 'updateTextFile', fileId: 'note1', content: 'new text', fileName: 'Renamed.txt' });
    assert.equal(up.result, 'success');
    assert.equal(files.lastPatch.name, 'Renamed.txt');
});

test('getStorageInfo returns GB strings', async () => {
    const r = await get({ action: 'getStorageInfo' });
    assert.deepEqual([r.storageUsed, r.storageTotal], ['3.0', '15']);
});

test('installDriveBridge answers bridge URLs and leaves other requests alone', async () => {
    const seen = [];
    const target = { fetch: async (u) => { seen.push(String(u)); return new Response('"native"'); } };
    installDriveBridge(target);
    assert.equal(await (await target.fetch('/api/anything')).json(), 'native');
    __setNativeFetchForTests(fakeNative);
    const res = await target.fetch(`${BRIDGE_URL}?action=fetchItems&folderId=${ROOT}`);
    assert.equal((await res.json()).result, 'success');
    assert.deepEqual(seen, ['/api/anything']);
});
