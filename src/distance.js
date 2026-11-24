// Distance and similarity metrics for fixed-length float vectors.
//
// Two views of the same numbers:
//   - `distance()` — lower is closer. Used inside the HNSW graph.
//   - `similarity()` — higher is more similar. Used for ranked results.
//
// Cosine vectors are normalised once at insert time, so a dot product *is*
// the cosine similarity and `1 - dot` *is* the cosine distance. Euclidean
// keeps raw vectors. Keeping this contract in one place is what makes the
// brute-force path and the HNSW path agree with each other.

import { ValidationError } from './errors.js';

export const METRICS = ['cosine', 'dot', 'euclidean'];

export function validateVector(vector, dimension) {
  if (!Array.isArray(vector) && !(vector instanceof Float32Array)) {
    throw new ValidationError('vector must be an array of numbers');
  }
  if (vector.length !== dimension) {
    throw new ValidationError(`vector must have dimension ${dimension}, got ${vector.length}`);
  }
  const out = new Float32Array(dimension);
  for (let i = 0; i < dimension; i++) {
    const v = vector[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new ValidationError(`vector[${i}] must be a finite number, got ${v}`);
    }
    out[i] = v;
  }
  return out;
}

export function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export function normalize(vector) {
  const n = Math.sqrt(dot(vector, vector));
  if (n === 0) {
    throw new ValidationError('zero vector cannot be normalised for cosine similarity');
  }
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / n;
  return out;
}

export function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

export function distance(metric, a, b) {
  switch (metric) {
    case 'cosine':
      return 1 - dot(a, b); // a and b are normalised at insert time
    case 'dot':
      return -dot(a, b);
    case 'euclidean':
      return euclideanDistance(a, b);
    default:
      throw new ValidationError(`unknown metric ${metric}`);
  }
}

export function similarity(metric, a, b) {
  switch (metric) {
    case 'cosine':
      return dot(a, b);
    case 'dot':
      return dot(a, b);
    case 'euclidean':
      return -euclideanDistance(a, b);
    default:
      throw new ValidationError(`unknown metric ${metric}`);
  }
}
