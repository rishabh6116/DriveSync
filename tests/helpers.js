// Shared helpers for the test-suite: an in-memory stand-in for MongoDB and a
// tiny fake of Vercel's req/res objects. Run everything with:  npm test

export function installFakeDb() {
    const docs = [];
    const match = (doc, q) => Object.entries(q || {}).every(([k, v]) => doc[k] === v);
    const dup = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    const accounts = {
        async findOne(q) { const d = docs.find((x) => match(x, q)); return d ? { _id: 'x', ...d } : null; },
        find(q) {
            const rows = docs.filter((x) => match(x, q));
            return { sort() { return this; }, async toArray() { return rows.map((r) => ({ _id: 'x', ...r })); } };
        },
        async insertOne(doc) {
            if (docs.some((d) => d.email === doc.email || d.id === doc.id)) throw dup();
            docs.push({ ...doc });
        },
        async updateOne(q, update) {
            const d = docs.find((x) => match(x, q));
            if (!d) return { matchedCount: 0 };
            Object.assign(d, update.$set || {});
            return { matchedCount: 1 };
        },
        async deleteOne(q) {
            const i = docs.findIndex((x) => match(x, q));
            if (i >= 0) docs.splice(i, 1);
            return { deletedCount: i >= 0 ? 1 : 0 };
        },
        async createIndex() {}
    };
    const db = { collection: () => accounts };
    globalThis.__driveSyncMongo = { dbPromise: Promise.resolve(db), indexesPromise: Promise.resolve() };
    return docs;
}

export function makeRes() {
    return {
        statusCode: 200,
        headers: {},
        body: undefined,
        setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
        status(c) { this.statusCode = c; return this; },
        json(o) { this.body = o; return this; },
        end() { return this; }
    };
}

export async function call(handler, { method = 'GET', query = {}, headers = {}, body } = {}) {
    const res = makeRes();
    const req = { method, query, body, headers: { host: 'drivesync.test', 'x-forwarded-proto': 'https', ...headers } };
    await handler(req, res);
    return res;
}

export const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
export const fakeIdToken = (claims) => `${b64u({ alg: 'none' })}.${b64u(claims)}.sig`;
