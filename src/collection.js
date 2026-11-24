// One collection: a fixed-dimension set of vectors with metadata, searched
// by brute force. The HNSW index (stage 2) attaches itself to `this.index`
// and takes over unfiltered search on non-trivial collections; filtered
// search always stays exact brute force, because a filter can leave too few
// candidates for a graph walk to be trustworthy. That split is deliberate
// and documented in the README.

import { normalize, similarity, validateVector, METRICS } from './distance.js';
import { matchFilter } from './filters.js';
import { HnswIndex } from './hnsw.js';
import { ValidationError } from './errors.js';

const HNSW_MIN_SIZE = 64;
// Rebuild the graph once tombstones pass 25% of the live set (min 16):
// lazy deletes are cheap, but a graph full of dead nodes wastes every walk.
const REBUILD_TOMBSTONE_FRACTION = 0.25;
const REBUILD_TOMBSTONE_MIN = 16;

export class Collection {
  constructor({ name, dimension, metric = 'cosine', seed = 42 }) {
    if (!name || typeof name !== 'string') {
      throw new ValidationError('collection name must be a non-empty string');
    }
    if (!Number.isInteger(dimension) || dimension < 1) {
      throw new ValidationError('dimension must be a positive integer');
    }
    if (!METRICS.includes(metric)) {
      throw new ValidationError(`unknown metric ${metric}; expected one of ${METRICS.join(', ')}`);
    }
    this.name = name;
    this.dimension = dimension;
    this.metric = metric;
    this.seed = seed;
    this.vectors = new Map(); // id -> { vector: Float32Array, metadata }
    // The graph is maintained on every insert from the start, but search
    // only trusts it once the collection is big enough for the walk to
    // beat a linear scan.
    this.index = new HnswIndex({ dimension, metric, seed });
  }

  #prepare(vector) {
    const v = validateVector(vector, this.dimension);
    return this.metric === 'cosine' ? normalize(v) : v;
  }

  upsert(id, vector, metadata = {}) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new ValidationError('vector id must be a non-empty string');
    }
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new ValidationError('metadata must be a plain object');
    }
    const stored = this.#prepare(vector);
    const created = !this.vectors.has(id);
    this.vectors.set(id, { vector: stored, metadata: { ...metadata } });
    if (this.index) this.index.upsert(id, stored);
    return { id, created };
  }

  upsertMany(items) {
    if (!Array.isArray(items)) throw new ValidationError('items must be an array');
    return items.map((item) => this.upsert(item.id, item.vector, item.metadata ?? {}));
  }

  delete(id) {
    const existed = this.vectors.delete(id);
    if (existed && this.index) {
      this.index.delete(id);
      if (
        this.index.deletedCount >=
        Math.max(REBUILD_TOMBSTONE_MIN, this.size * REBUILD_TOMBSTONE_FRACTION)
      ) {
        this.index.rebuild(
          [...this.vectors.entries()].map(([vid, entry]) => ({ id: vid, vector: entry.vector })),
        );
      }
    }
    return existed;
  }

  get(id) {
    const entry = this.vectors.get(id);
    if (!entry) return null;
    return { id, vector: Array.from(entry.vector), metadata: { ...entry.metadata } };
  }

  get size() {
    return this.vectors.size;
  }

  search(query, { k = 10, filter = null } = {}) {
    const q = this.#prepare(query);
    if (!Number.isInteger(k) || k < 1) {
      throw new ValidationError('k must be a positive integer');
    }
    if (!filter && this.index && this.size >= HNSW_MIN_SIZE) {
      // The index returns ids + scores; metadata lives in the collection.
      return this.index.search(q, k).map((r) => ({
        ...r,
        metadata: { ...this.vectors.get(r.id).metadata },
      }));
    }
    return this.#bruteForce(q, k, filter);
  }

  #bruteForce(q, k, filter) {
    const scored = [];
    for (const [id, entry] of this.vectors) {
      if (filter && !matchFilter(entry.metadata, filter)) continue;
      scored.push({
        id,
        score: similarity(this.metric, q, entry.vector),
        metadata: { ...entry.metadata },
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  toJSON() {
    return {
      name: this.name,
      dimension: this.dimension,
      metric: this.metric,
      seed: this.seed,
      vectors: [...this.vectors.entries()].map(([id, entry]) => ({
        id,
        vector: Array.from(entry.vector),
        metadata: entry.metadata,
      })),
    };
  }

  static fromJSON(data) {
    const collection = new Collection({
      name: data.name,
      dimension: data.dimension,
      metric: data.metric,
      seed: data.seed ?? 42,
    });
    for (const item of data.vectors ?? []) {
      collection.vectors.set(item.id, {
        vector: Float32Array.from(item.vector),
        metadata: item.metadata ?? {},
      });
    }
    collection.index.rebuild(
      [...collection.vectors.entries()].map(([id, entry]) => ({ id, vector: entry.vector })),
    );
    return collection;
  }
}
