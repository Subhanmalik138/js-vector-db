import test from 'node:test';
import assert from 'node:assert/strict';
import { distance, similarity, normalize, validateVector } from '../src/distance.js';
import { ValidationError } from '../src/errors.js';

test('cosine similarity of identical vectors is 1', () => {
  const a = normalize(new Float32Array([3, 4]));
  assert.ok(Math.abs(similarity('cosine', a, a) - 1) < 1e-6); // float32 rounding
});

test('cosine similarity of orthogonal vectors is 0', () => {
  const a = normalize(new Float32Array([1, 0]));
  const b = normalize(new Float32Array([0, 1]));
  assert.equal(similarity('cosine', a, b), 0);
});

test('dot product is raw and unnormalised', () => {
  const a = new Float32Array([2, 0]);
  const b = new Float32Array([3, 0]);
  assert.equal(similarity('dot', a, b), 6);
  assert.equal(distance('dot', a, b), -6);
});

test('euclidean similarity is the negated distance', () => {
  const a = new Float32Array([0, 0]);
  const b = new Float32Array([3, 4]);
  assert.equal(similarity('euclidean', a, b), -5);
  assert.equal(distance('euclidean', a, b), 5);
});

test('cosine distance is 1 minus similarity', () => {
  const a = normalize(new Float32Array([1, 1]));
  const b = normalize(new Float32Array([1, 0]));
  assert.ok(Math.abs(distance('cosine', a, b) - (1 - similarity('cosine', a, b))) < 1e-9);
});

test('normalize rejects the zero vector', () => {
  assert.throws(() => normalize(new Float32Array([0, 0])), ValidationError);
});

test('validateVector rejects wrong dimension and non-finite values', () => {
  assert.throws(() => validateVector([1, 2], 3), ValidationError);
  assert.throws(() => validateVector([1, Number.NaN], 2), ValidationError);
  assert.throws(() => validateVector([1, Number.POSITIVE_INFINITY], 2), ValidationError);
  assert.throws(() => validateVector('nope', 2), ValidationError);
  assert.deepEqual([...validateVector([1, 2], 2)], [1, 2]);
});

test('unknown metric throws', () => {
  const a = new Float32Array([1]);
  assert.throws(() => similarity('manhattan', a, a), ValidationError);
});
