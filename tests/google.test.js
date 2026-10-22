import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb, call, fakeIdToken } from './helpers.js';

process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.GOOGLE_CLIENT_ID = 'client-id.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
process.env.APP_URL = 'https://drivesync.test';
process.env.REGISTRATION_ENABLED = 'true';

const docs = installFakeDb();
const { default: google } = await import('../api/google.js');
const { default: me } = await import('../api/me.js');
const { default: auth } = await import('../api/auth.js');
const { default: register } = await import('../api/register.js');
const gl = await import('../lib/google.js');
const { hashPassword } = await import('../lib/passwords.js');

const FOLDER_ID = 'FolderId1234567890abc';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
let calls;
let tokenResponse;
let refreshResponse;

function mockGoogle() {
    calls = [];
    globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        calls.push({ url: u, init });
        const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
        if (u === 'https://oauth2.googleapis.com/token') {
            const params = new URLSearchParams(init.body);
            if (params.get('grant_type') === 'refresh_token') return refreshResponse();
            return tokenResponse(params);
        }
        if (u.startsWith('https://www.googleapis.com/drive/v3/files')) {
            if ((init.method || 'GET') === 'POST') return json({ id: FOLDER_ID });
            return json({ id: FOLDER_ID, trashed: false });
        }
        if (u.startsWith('https://lh3.googleusercontent.com/')) {
            return new Response(JPEG, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
        }
        if (u === 'https://oauth2.googleapis.com/revoke') return json({});
        throw new Error('Unexpected fetch: ' + u);
    };
}

const claims = (over = {}) => ({
    sub: 'g-111', email: 'Rishabh@Example.com', email_verified: true, name: 'Rishabh Singh',
    picture: 'https://lh3.googleusercontent.com/a/abc=s96-c', ...over
});

function okTokens(over = {}, scope) {
    return () => new Response(JSON.stringify({
        access_token: 'access-1', expires_in: 3600, refresh_token: 'refresh-secret-1',
        scope: scope || 'openid email profile https://www.googleapis.com/auth/drive',
        id_token: fakeIdToken(claims(over))
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// Runs "start login" then the callback, returning the callback response.
async function googleLogin({ tokens } = {}) {
    tokenResponse = tokens || okTokens();
    const start = await call(google, { query: { action: 'login' } });
    assert.equal(start.statusCode, 302);
    const loc = new URL(start.headers.location);
    const cookie = String(start.headers['set-cookie']).split(';')[0];
    return call(google, {
        query: { code: 'auth-code', state: loc.searchParams.get('state') },
        headers: { cookie }
    });
}

const fragment = (res) => new URLSearchParams(res.headers.location.replace(/^\/#/, ''));

before(mockGoogle);
beforeEach(() => { docs.length = 0; mockGoogle(); refreshResponse = () => new Response(JSON.stringify({ access_token: 'access-2', expires_in: 3600 }), { status: 200 }); });

test('login redirect asks for sign-in + the full drive scope (so manually added files are visible)', async () => {
    const res = await call(google, { query: { action: 'login' } });
    const url = new URL(res.headers.location);
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://drivesync.test/api/google');
    const scope = url.searchParams.get('scope');
    assert.ok(scope.split(' ').includes('https://www.googleapis.com/auth/drive'));
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.match(String(res.headers['set-cookie']), /HttpOnly/);
});

test('new Google user: account created without a password, Drive folder + encrypted token saved', async () => {
    const res = await googleLogin();
    const f = fragment(res);
    assert.ok(f.get('gauth'));
    assert.equal(f.get('setpw'), '1');
    assert.equal(docs.length, 1);
    const acct = docs[0];
    assert.equal(acct.email, 'rishabh@example.com');
    assert.equal(acct.label, 'Rishabh Singh');
    assert.equal(acct.passwordHash, '');
    assert.equal(acct.rootFolderId, FOLDER_ID);
    assert.ok(acct.avatar.startsWith('data:image/jpeg;base64,'));
    assert.ok(acct.driveRefreshToken.startsWith('v1.'));
    assert.ok(!acct.driveRefreshToken.includes('refresh-secret-1'));
    assert.equal(gl.decryptToken(acct.driveRefreshToken), 'refresh-secret-1');
});

test('Google-only account cannot use the email form until a password is set', async () => {
    await googleLogin();
    const res = await call(auth, { method: 'POST', body: { email: 'rishabh@example.com', password: 'anything' } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.googleOnly, true);
});

test('set a password after Google sign-in, then sign in with email + password too', async () => {
    const f = fragment(await googleLogin());
    const token = f.get('gauth');

    const info = await call(me, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(info.body.account.hasPassword, false);
    assert.equal(info.body.config.driveMode, 'google');
    assert.equal(info.body.config.macroUrl, 'drivesync-bridge://drive');

    // no currentPassword needed because none exists yet
    const set = await call(me, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: { newPassword: 'my-new-pass' } });
    assert.equal(set.statusCode, 200, JSON.stringify(set.body));
    assert.equal(set.body.passwordChanged, true);
    assert.ok(set.body.token && set.body.token !== token);
    assert.equal(set.body.account.hasPassword, true);

    // old token is invalid now, new one works
    assert.equal((await call(me, { headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
    assert.equal((await call(me, { headers: { authorization: `Bearer ${set.body.token}` } })).statusCode, 200);

    const login = await call(auth, { method: 'POST', body: { email: 'rishabh@example.com', password: 'my-new-pass' } });
    assert.equal(login.statusCode, 200);
    assert.equal(login.body.config.driveMode, 'google');
    const bad = await call(auth, { method: 'POST', body: { email: 'rishabh@example.com', password: 'wrong' } });
    assert.equal(bad.statusCode, 401);

    // once a password exists, changes need it
    const noPw = await call(me, { method: 'PUT', headers: { authorization: `Bearer ${set.body.token}` }, body: { label: 'New Name' } });
    assert.equal(noPw.statusCode, 400);
});

test('Google sign-in links to an existing email/password account with the same verified email', async () => {
    docs.push({ id: 'acct_1', label: 'Old', email: 'rishabh@example.com', passwordHash: await hashPassword('pw123') });
    const f = fragment(await googleLogin());
    assert.ok(f.get('gauth'));
    assert.equal(f.get('setpw'), null);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].googleId, 'g-111');
    assert.ok(docs[0].passwordHash.startsWith('scrypt$')); // password login keeps working
    const login = await call(auth, { method: 'POST', body: { email: 'rishabh@example.com', password: 'pw123' } });
    assert.equal(login.statusCode, 200);
});

test('registration without Drive details works; Drive stays "pending" until connected', async () => {
    const reg = await call(register, { method: 'POST', body: { label: 'Neha', email: 'neha@example.com', password: 'pw1' } });
    assert.equal(reg.statusCode, 201, JSON.stringify(reg.body));
    const login = await call(auth, { method: 'POST', body: { email: 'neha@example.com', password: 'pw1' } });
    assert.equal(login.body.config.driveMode, 'pending');
    assert.equal(login.body.config.rootFolderId, 'pending');
    const token = login.body.token;

    const noDrive = await call(me, { query: { drive: 'token' }, headers: { authorization: `Bearer ${token}` } });
    assert.equal(noDrive.statusCode, 409);
    assert.equal(noDrive.body.needsConnect, true);

    // connect flow
    tokenResponse = okTokens({ sub: 'g-222', email: 'neha.drive@gmail.com' });
    const start = await call(google, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: { action: 'connect' } });
    assert.equal(start.statusCode, 200);
    const url = new URL(start.body.url);
    assert.equal(url.searchParams.get('prompt'), 'consent select_account');
    const cookie = String(start.headers['set-cookie']).split(';')[0];
    const back = await call(google, { query: { code: 'c', state: url.searchParams.get('state') }, headers: { cookie } });
    assert.equal(back.headers.location, '/#gdone=1');
    const acct = docs.find((d) => d.email === 'neha@example.com');
    assert.equal(acct.rootFolderId, FOLDER_ID);
    assert.equal(acct.googleEmail, 'neha.drive@gmail.com');
    assert.equal(acct.email, 'neha@example.com'); // login email unchanged

    const tok = await call(me, { query: { drive: 'token' }, headers: { authorization: `Bearer ${token}` } });
    assert.equal(tok.statusCode, 200);
    assert.equal(tok.body.accessToken, 'access-2');
    const cfg = await call(me, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(cfg.body.config.driveMode, 'google');
    assert.equal(cfg.body.config.driveEmail, 'neha.drive@gmail.com');
});

test('a revoked Google grant (invalid_grant) clears the connection and asks to reconnect', async () => {
    const f = fragment(await googleLogin());
    refreshResponse = () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    const res = await call(me, { query: { drive: 'token' }, headers: { authorization: `Bearer ${f.get('gauth')}` } });
    assert.equal(res.statusCode, 409);
    assert.equal(docs[0].driveRefreshToken, '');
});

test('disconnecting Drive needs the password when one is set, and revokes the token', async () => {
    docs.push({ id: 'acct_9', label: 'A', email: 'a@example.com', passwordHash: await hashPassword('pw9') });
    const login = await call(auth, { method: 'POST', body: { email: 'a@example.com', password: 'pw9' } });
    const token = login.body.token;
    docs[0].driveRefreshToken = gl.encryptToken('rt-9');
    docs[0].rootFolderId = FOLDER_ID;

    const no = await call(me, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: { disconnectDrive: true } });
    assert.equal(no.statusCode, 400);
    const bad = await call(me, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: { disconnectDrive: true, currentPassword: 'nope' } });
    assert.equal(bad.statusCode, 401);
    const ok = await call(me, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: { disconnectDrive: true, currentPassword: 'pw9' } });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.config.driveMode, 'pending');
    assert.equal(docs[0].driveRefreshToken, '');
    assert.ok(calls.some((c) => c.url === 'https://oauth2.googleapis.com/revoke'));
});

test('tampered state, wrong cookie and cancelled consent are rejected', async () => {
    const start = await call(google, { query: { action: 'login' } });
    const state = new URL(start.headers.location).searchParams.get('state');
    const cookie = String(start.headers['set-cookie']).split(';')[0];

    const noCookie = await call(google, { query: { code: 'c', state } });
    assert.equal(fragment(noCookie).get('gerror'), 'state');
    const forged = await call(google, { query: { code: 'c', state: state.slice(0, -2) + 'xx' }, headers: { cookie } });
    assert.equal(fragment(forged).get('gerror'), 'state');
    const denied = await call(google, { query: { error: 'access_denied' } });
    assert.equal(fragment(denied).get('gerror'), 'cancelled');
    assert.equal(docs.length, 0);
});

test('closed registration also blocks creating accounts through Google', async () => {
    process.env.REGISTRATION_ENABLED = 'false';
    try {
        const res = await googleLogin();
        assert.equal(fragment(res).get('gerror'), 'registration_closed');
        assert.equal(docs.length, 0);
    } finally {
        process.env.REGISTRATION_ENABLED = 'true';
    }
});

test('if the user un-ticks the Drive permission, sign-in works but Drive stays pending', async () => {
    const res = await googleLogin({ tokens: okTokens({}, 'openid email profile') });
    const f = fragment(res);
    assert.ok(f.get('gauth'));
    assert.equal(docs[0].driveRefreshToken, undefined);
    const cfg = await call(me, { headers: { authorization: `Bearer ${f.get('gauth')}` } });
    assert.equal(cfg.body.config.driveMode, 'pending');
});

test('Google user already linked can sign in again without a new refresh token', async () => {
    await googleLogin();
    const stored = docs[0].driveRefreshToken;
    const again = await googleLogin({ tokens: () => new Response(JSON.stringify({
        access_token: 'a', expires_in: 3600, scope: 'openid email profile https://www.googleapis.com/auth/drive',
        id_token: fakeIdToken(claims())
    }), { status: 200 }) });
    const f = fragment(again);
    assert.ok(f.get('gauth'));
    assert.equal(f.get('setpw'), null);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].driveRefreshToken, stored);
});

test('GET /api/google reports whether Google is configured; register exposes googleEnabled', async () => {
    assert.equal((await call(google)).body.configured, true);
    assert.equal((await call(register)).body.googleEnabled, true);
});

test('avatar download refuses non-Google hosts', async () => {
    assert.equal(await gl.fetchAvatarDataUrl('https://evil.example.com/a.jpg'), '');
    assert.equal(await gl.fetchAvatarDataUrl('http://lh3.googleusercontent.com/a'), '');
    assert.equal(await gl.fetchAvatarDataUrl('not a url'), '');
});

test('account still holding only the old drive.file scope is asked to reconnect', async () => {
    const f = fragment(await googleLogin());
    refreshResponse = () => new Response(JSON.stringify({
        access_token: 'access-old', expires_in: 3600,
        scope: 'openid email profile https://www.googleapis.com/auth/drive.file'
    }), { status: 200 });
    const res = await call(me, { query: { drive: 'token' }, headers: { authorization: `Bearer ${f.get('gauth')}` } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.needsConnect, true);
});
