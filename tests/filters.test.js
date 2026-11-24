import test from 'node:test';
import assert from 'node:assert/strict';
import { matchFilter } from '../src/filters.js';
import { ValidationError } from '../src/errors.js';

const meta = { lang: 'en', score: 0.7, tags: ['a', 'b'], nested: { x: 1 } };

test('empty filter matches everything', () => {
  assert.equal(matchFilter(meta, {}), true);
  assert.equal(matchFilter(meta, null), true);
});

test('equality shorthand and deep equality', () => {
  assert.equal(matchFilter(meta, { lang: 'en' }), true);
  assert.equal(matchFilter(meta, { lang: 'ur' }), false);
  assert.equal(matchFilter(meta, { nested: { x: 1 } }), true);
  assert.equal(matchFilter(meta, { nested: { x: 2 } }), false);
});

test('comparison operators', () => {
  assert.equal(matchFilter(meta, { score: { $gte: 0.7 } }), true);
  assert.equal(matchFilter(meta, { score: { $gt: 0.7 } }), false);
  assert.equal(matchFilter(meta, { score: { $lt: 0.8, $gte: 0.5 } }), true);
  assert.equal(matchFilter(meta, { score: { $lte: 0.6 } }), false);
  assert.equal(matchFilter(meta, { score: { $ne: 0.5 } }), true);
  assert.equal(matchFilter(meta, { score: { $eq: 0.7 } }), true);
});

test('$in, $nin and $contains', () => {
  assert.equal(matchFilter(meta, { lang: { $in: ['en', 'fr'] } }), true);
  assert.equal(matchFilter(meta, { lang: { $in: ['ur'] } }), false);
  assert.equal(matchFilter(meta, { lang: { $nin: ['ur'] } }), true);
  assert.equal(matchFilter(meta, { tags: { $contains: 'a' } }), true);
  assert.equal(matchFilter(meta, { tags: { $contains: 'z' } }), false);
  assert.equal(matchFilter(meta, { lang: { $contains: 'e' } }), false);
});

test('$exists distinguishes missing from present', () => {
  assert.equal(matchFilter(meta, { missing: { $exists: false } }), true);
  assert.equal(matchFilter(meta, { lang: { $exists: true } }), true);
  assert.equal(matchFilter(meta, { missing: { $exists: true } }), false);
});

test('$and and $or compose', () => {
  assert.equal(matchFilter(meta, { $and: [{ lang: 'en' }, { score: { $gt: 0.5 } }] }), true);
  assert.equal(matchFilter(meta, { $and: [{ lang: 'en' }, { score: { $gt: 0.9 } }] }), false);
  assert.equal(matchFilter(meta, { $or: [{ lang: 'ur' }, { score: { $gt: 0.5 } }] }), true);
  assert.equal(matchFilter(meta, { $or: [{ lang: 'ur' }, { score: { $gt: 0.9 } }] }), false);
});

test('unknown operators fail loudly', () => {
  assert.throws(() => matchFilter(meta, { score: { $near: 1 } }), ValidationError);
  assert.throws(() => matchFilter(meta, { $nor: [] }), ValidationError);
  assert.throws(() => matchFilter(meta, { score: { $in: 'en' } }), ValidationError);
});
