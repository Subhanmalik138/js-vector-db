import test from 'node:test';
import assert from 'node:assert/strict';
import { VectorStore } from '../src/store.js';
import { normalize, similarity } from '../src/distance.js';
import { mulberry32 } from '../src/rng.js';

function randomVectors(count, dim, seed) {
  const rng = mulberry32(seed);
  return Array.from({ length: count }, () =>
    Array.from({ length: dim }, () => rng() * 2 - 1),
  );
}

function bruteForceTopK(vectors, query, k) {
  const q = normalize(new Float32Array(query));
  return vectors
    .map((v, i) => ({ id: `v${i}`, score: similarity('cosine', q, normalize(new Float32Array(v))) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((r) => r.id);
}

test('HNSW recall@10 is at least 0.95 on 500 random 16-d vectors', () => {
  const dim = 16;
  const vectors = randomVectors(500, dim, 7);
  const store = new VectorStore();
  const c = store.createCollection('emb', dim, 'cosine', 123);
  vectors.forEach((v, i) => c.upsert(`v${i}`, v));

  const queries = randomVectors(20, dim, 99);
  let totalRecall = 0;
  for (const q of queries) {
    const exact = new Set(bruteForceTopK(vectors, q, 10));
    const approx = c.search(q, { k: 10 }).map((r) => r.id);
    totalRecall += approx.filter((id) => exact.has(id)).length / 10;
  }
  const meanRecall = totalRecall / queries.length;
  assert.ok(meanRecall >= 0.95, `mean recall@10 was ${meanRecall}`);
});

test('HNSW agrees with brute force on small collections via the same path', () => {
  // Below the 64-vector threshold search is brute force; above it, HNSW.
  // Both must return the same top-1 for an exact-match query.
  const store = new VectorStore();
  const c = store.createCollection('emb', 4, 'cosine', 5);
  for (let i = 0; i < 100; i++) {
    c.upsert(`v${i}`, [i / 100, 1 - i / 100, 0.5, 0.25]);
  }
  const target = [0.425, 0.575, 0.5, 0.25];
  c.upsert('target', target);
  assert.equal(c.search(target, { k: 1 })[0].id, 'target');
});

test('deletes never surface in results and re-upsert replaces the vector', () => {
  const store = new VectorStore();
  const c = store.createCollection('emb', 2, 'cosine', 11);
  for (let i = 0; i < 80; i++) c.upsert(`v${i}`, [Math.cos(i), Math.sin(i)]);
  c.delete('v10');
  c.delete('v20');
  const ids = c.search([1, 0], { k: 80 }).map((r) => r.id);
  assert.ok(!ids.includes('v10') && !ids.includes('v20'));
  c.upsert('v10', [0, -1]);
  assert.equal(c.search([0, -1], { k: 1 })[0].id, 'v10');
});

test('heavy deletes trigger a rebuild and search stays correct', () => {
  const store = new VectorStore();
  const c = store.createCollection('emb', 2, 'cosine', 3);
  for (let i = 0; i < 100; i++) c.upsert(`v${i}`, [i / 100, 1 - i / 100]);
  for (let i = 0; i < 60; i++) c.delete(`v${i}`);
  assert.equal(c.index.deletedCount < 60, true); // a rebuild reset the count
  assert.equal(c.size, 40);
  const ids = c.search([1, 0], { k: 40 }).map((r) => r.id);
  assert.equal(ids.length, 40);
  assert.ok(ids.every((id) => Number(id.slice(1)) >= 60));
});

test('same seed and insert order build the same graph', () => {
  const build = () => {
    const store = new VectorStore();
    const c = store.createCollection('emb', 8, 'cosine', 77);
    randomVectors(120, 8, 4).forEach((v, i) => c.upsert(`v${i}`, v));
    return c.search([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5], { k: 10 }).map((r) => r.id);
  };
  assert.deepEqual(build(), build());
});

test('euclidean HNSW finds the nearest neighbour', () => {
  const store = new VectorStore();
  const c = store.createCollection('pts', 2, 'euclidean', 9);
  for (let i = 0; i < 80; i++) c.upsert(`p${i}`, [i, i * 2]);
  assert.equal(c.search([50.1, 100.2], { k: 1 })[0].id, 'p50');
});
