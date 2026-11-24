import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistentStore } from '../src/persistence.js';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'vectordb-test-'));
}

async function seed(dir, { autoSnapshotOps = 1000 } = {}) {
  const ps = await PersistentStore.open(dir, { autoSnapshotOps });
  await ps.mutate({ type: 'create-collection', name: 'docs', dimension: 2, metric: 'cosine' });
  await ps.mutate({ type: 'upsert', collection: 'docs', id: 'a', vector: [1, 0], metadata: { lang: 'en' } });
  await ps.mutate({ type: 'upsert', collection: 'docs', id: 'b', vector: [0, 1], metadata: { lang: 'ur' } });
  return ps;
}

test('reopening replays the WAL and restores vectors', async () => {
  const dir = await tempDir();
  try {
    await seed(dir);
    const reopened = await PersistentStore.open(dir);
    assert.equal(reopened.replayed, 3);
    assert.equal(reopened.skipped, 0);
    const c = reopened.getCollection('docs');
    assert.equal(c.size, 2);
    assert.equal(c.search([1, 0], { k: 1 })[0].id, 'a');
    assert.deepEqual(c.get('b').metadata, { lang: 'ur' });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a torn final WAL line is skipped, earlier ops still apply', async () => {
  const dir = await tempDir();
  try {
    await seed(dir);
    await fs.appendFile(path.join(dir, 'wal.jsonl'), '{"type":"upsert","collection":"docs","id":"tor');
    const reopened = await PersistentStore.open(dir);
    assert.equal(reopened.skipped, 1);
    assert.equal(reopened.getCollection('docs').size, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('snapshot truncates the WAL and a later reopen still restores everything', async () => {
  const dir = await tempDir();
  try {
    const ps = await seed(dir);
    await ps.snapshot();
    const wal = await fs.readFile(path.join(dir, 'wal.jsonl'), 'utf8');
    assert.equal(wal, '');
    const reopened = await PersistentStore.open(dir);
    assert.equal(reopened.replayed, 0);
    assert.equal(reopened.getCollection('docs').size, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('auto-snapshot fires at the threshold and replay stays consistent', async () => {
  const dir = await tempDir();
  try {
    const ps = await PersistentStore.open(dir, { autoSnapshotOps: 4 });
    await ps.mutate({ type: 'create-collection', name: 'c', dimension: 2 });
    for (let i = 0; i < 6; i++) {
      await ps.mutate({ type: 'upsert', collection: 'c', id: `v${i}`, vector: [i + 1, 1] });
    }
    // 7 ops with a threshold of 4: a snapshot fired mid-run.
    const reopened = await PersistentStore.open(dir);
    assert.equal(reopened.getCollection('c').size, 6);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a failed mutation is never written to the WAL', async () => {
  const dir = await tempDir();
  try {
    const ps = await seed(dir);
    await assert.rejects(ps.mutate({ type: 'upsert', collection: 'docs', id: 'x', vector: [1] }));
    const reopened = await PersistentStore.open(dir);
    assert.equal(reopened.getCollection('docs').size, 2);
    assert.equal(reopened.replayed, 3);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('HNSW search still works after a snapshot + WAL reopen', async () => {
  const dir = await tempDir();
  try {
    const ps = await PersistentStore.open(dir);
    await ps.mutate({ type: 'create-collection', name: 'emb', dimension: 4, metric: 'cosine', seed: 42 });
    for (let i = 0; i < 100; i++) {
      await ps.mutate({ type: 'upsert', collection: 'emb', id: `v${i}`, vector: [i / 100, 1 - i / 100, 0.5, 0.25] });
    }
    await ps.snapshot();
    const reopened = await PersistentStore.open(dir);
    const c = reopened.getCollection('emb');
    assert.equal(c.size, 100);
    assert.equal(c.search([0.42, 0.58, 0.5, 0.25], { k: 1 })[0].id, 'v42');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
