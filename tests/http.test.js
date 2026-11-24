import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistentStore } from '../src/persistence.js';
import { createServer } from '../src/server.js';

async function startServer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vectordb-http-'));
  const persistent = await PersistentStore.open(dir);
  const api = createServer(persistent, { port: 0 });
  await api.listen();
  const port = api.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    async stop() {
      await api.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

async function request(base, method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test('health reports counts', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const { status, json } = await request(srv.base, 'GET', '/health');
  assert.equal(status, 200);
  assert.equal(json.status, 'ok');
  assert.equal(json.collections, 0);
});

test('full CRUD + search flow over HTTP', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  let r = await request(srv.base, 'PUT', '/collections/docs', { dimension: 2 });
  assert.equal(r.status, 201);
  assert.equal(r.json.collection.name, 'docs');

  r = await request(srv.base, 'PUT', '/collections/docs', { dimension: 2 });
  assert.equal(r.status, 409);

  r = await request(srv.base, 'POST', '/collections/docs/vectors', {
    vectors: [
      { id: 'a', vector: [1, 0], metadata: { lang: 'en' } },
      { id: 'b', vector: [0, 1], metadata: { lang: 'ur' } },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.upserted.length, 2);

  r = await request(srv.base, 'POST', '/collections/docs/search', { vector: [1, 0], k: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.results[0].id, 'a');

  r = await request(srv.base, 'POST', '/collections/docs/search', {
    vector: [1, 0],
    filter: { lang: 'ur' },
  });
  assert.equal(r.json.results[0].id, 'b');

  r = await request(srv.base, 'GET', '/collections/docs/vectors/b');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.vector.metadata, { lang: 'ur' });

  r = await request(srv.base, 'DELETE', '/collections/docs/vectors/b');
  assert.equal(r.status, 200);
  r = await request(srv.base, 'GET', '/collections/docs/vectors/b');
  assert.equal(r.status, 404);

  r = await request(srv.base, 'DELETE', '/collections/docs');
  assert.equal(r.status, 200);
  r = await request(srv.base, 'GET', '/collections');
  assert.deepEqual(r.json.collections, []);
});

test('bad input maps to 400 and unknown routes to 404', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  let r = await request(srv.base, 'PUT', '/collections/x', { dimension: 0 });
  assert.equal(r.status, 400);
  r = await request(srv.base, 'POST', '/collections/nope/search', { vector: [1, 0] });
  assert.equal(r.status, 404);
  r = await request(srv.base, 'GET', '/nope');
  assert.equal(r.status, 404);
});

test('invalid JSON body is rejected with 400', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const res = await fetch(`${srv.base}/collections/x`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
});
