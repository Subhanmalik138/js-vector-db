import test from 'node:test';
import assert from 'node:assert/strict';
import { VectorStore } from '../src/store.js';
import { ValidationError, NotFoundError, ConflictError } from '../src/errors.js';

function storeWithDocs() {
  const store = new VectorStore();
  const c = store.createCollection('docs', 3, 'cosine');
  c.upsert('a', [1, 0, 0], { lang: 'en', score: 0.9 });
  c.upsert('b', [0, 1, 0], { lang: 'ur', score: 0.4 });
  c.upsert('c', [0.9, 0.1, 0], { lang: 'en', score: 0.7 });
  return { store, c };
}

test('upsert returns created flag and get round-trips the vector', () => {
  const { c } = storeWithDocs();
  assert.deepEqual(c.upsert('d', [0, 0, 1]), { id: 'd', created: true });
  assert.deepEqual(c.upsert('d', [0, 0, 1]), { id: 'd', created: false });
  assert.equal(c.get('d').vector.length, 3);
  assert.equal(c.get('missing'), null);
});

test('search ranks by similarity, most similar first', () => {
  const { c } = storeWithDocs();
  const results = c.search([1, 0, 0], { k: 3 });
  assert.deepEqual(results.map((r) => r.id), ['a', 'c', 'b']);
  assert.ok(results[0].score > results[1].score);
});

test('search honours k and metadata filters', () => {
  const { c } = storeWithDocs();
  assert.equal(c.search([1, 0, 0], { k: 1 }).length, 1);
  const filtered = c.search([1, 0, 0], { filter: { lang: 'ur' } });
  assert.deepEqual(filtered.map((r) => r.id), ['b']);
  const ranged = c.search([1, 0, 0], { filter: { score: { $gte: 0.8 } } });
  assert.deepEqual(ranged.map((r) => r.id), ['a']);
});

test('delete removes the vector and reports existence', () => {
  const { c } = storeWithDocs();
  assert.equal(c.delete('a'), true);
  assert.equal(c.delete('a'), false);
  assert.equal(c.size, 2);
  assert.deepEqual(c.search([1, 0, 0], { k: 5 }).map((r) => r.id), ['c', 'b']);
});

test('euclidean collections rank nearest first', () => {
  const store = new VectorStore();
  const c = store.createCollection('points', 2, 'euclidean');
  c.upsert('near', [0.1, 0.1]);
  c.upsert('far', [10, 10]);
  assert.equal(c.search([0, 0], { k: 1 })[0].id, 'near');
});

test('validation rejects bad ids, dimensions and metrics', () => {
  const store = new VectorStore();
  assert.throws(() => store.createCollection('x', 0), ValidationError);
  assert.throws(() => store.createCollection('x', 2, 'manhattan'), ValidationError);
  const c = store.createCollection('x', 2);
  assert.throws(() => c.upsert('', [1, 2]), ValidationError);
  assert.throws(() => c.upsert('a', [1]), ValidationError);
  assert.throws(() => c.upsert('a', [1, 2], []), ValidationError);
  assert.throws(() => c.search([1, 2], { k: 0 }), ValidationError);
});

test('store rejects duplicate collections and missing lookups', () => {
  const { store } = storeWithDocs();
  assert.throws(() => store.createCollection('docs', 3), ConflictError);
  assert.throws(() => store.getCollection('nope'), NotFoundError);
  assert.throws(() => store.deleteCollection('nope'), NotFoundError);
  assert.deepEqual(store.listCollections(), [
    { name: 'docs', dimension: 3, metric: 'cosine', size: 3 },
  ]);
});

test('JSON round-trip preserves vectors, metadata and search order', () => {
  const { store, c } = storeWithDocs();
  const restored = VectorStore.fromJSON(store.toJSON());
  const again = restored.getCollection('docs');
  assert.deepEqual(again.search([1, 0, 0], { k: 3 }).map((r) => r.id), ['a', 'c', 'b']);
  assert.deepEqual(again.get('b').metadata, { lang: 'ur', score: 0.4 });
  assert.equal(c.size, again.size);
});
