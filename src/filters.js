// Metadata filters, in the style of MongoDB's query language but deliberately
// small: equality shorthand plus a fixed operator set, with $and / $or for
// composition. Anything outside that set is rejected, so a typo in a filter
// fails loudly instead of silently matching nothing.
//
//   { category: 'docs' }                          // equality shorthand
//   { score: { $gte: 0.5, $lt: 0.9 } }            // range
//   { tags: { $contains: 'urgent' } }             // array membership
//   { $or: [{ lang: 'en' }, { lang: 'ur' }] }     // composition

import { ValidationError } from './errors.js';

const OPERATORS = new Set([
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$contains', '$exists',
]);

export function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

function applyOperator(op, value, expected) {
  switch (op) {
    case '$eq':
      return deepEqual(value, expected);
    case '$ne':
      return !deepEqual(value, expected);
    case '$gt':
      return value !== undefined && value > expected;
    case '$gte':
      return value !== undefined && value >= expected;
    case '$lt':
      return value !== undefined && value < expected;
    case '$lte':
      return value !== undefined && value <= expected;
    case '$in':
      if (!Array.isArray(expected)) {
        throw new ValidationError('$in expects an array of values');
      }
      return expected.some((v) => deepEqual(value, v));
    case '$nin':
      if (!Array.isArray(expected)) {
        throw new ValidationError('$nin expects an array of values');
      }
      return !expected.some((v) => deepEqual(value, v));
    case '$contains':
      return Array.isArray(value) && value.some((v) => deepEqual(v, expected));
    case '$exists':
      return expected ? value !== undefined : value === undefined;
    default:
      throw new ValidationError(`unknown operator ${op}`);
  }
}

function isOperatorObject(condition) {
  return (
    condition !== null &&
    typeof condition === 'object' &&
    !Array.isArray(condition) &&
    Object.keys(condition).some((k) => k.startsWith('$'))
  );
}

export function matchFilter(metadata, filter) {
  if (!filter || Object.keys(filter).length === 0) return true;
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) {
    throw new ValidationError('filter must be an object');
  }
  for (const [key, condition] of Object.entries(filter)) {
    if (key === '$and') {
      if (!Array.isArray(condition)) throw new ValidationError('$and expects an array of filters');
      if (!condition.every((f) => matchFilter(metadata, f))) return false;
      continue;
    }
    if (key === '$or') {
      if (!Array.isArray(condition)) throw new ValidationError('$or expects an array of filters');
      if (!condition.some((f) => matchFilter(metadata, f))) return false;
      continue;
    }
    if (key.startsWith('$')) {
      throw new ValidationError(`unknown top-level operator ${key}`);
    }
    const value = metadata ? metadata[key] : undefined;
    if (isOperatorObject(condition)) {
      for (const [op, expected] of Object.entries(condition)) {
        if (!OPERATORS.has(op)) {
          throw new ValidationError(`unknown operator ${op} on field ${key}`);
        }
        if (!applyOperator(op, value, expected)) return false;
      }
    } else if (!deepEqual(value, condition)) {
      return false;
    }
  }
  return true;
}
