// The store: a set of named collections. Every mutation goes through
// `applyOp`, a single choke-point that the WAL (stage 3) records and replays,
// so the on-disk log and the in-memory state can never drift apart.

import { Collection } from './collection.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';

export class VectorStore {
  constructor() {
    this.collections = new Map(); // name -> Collection
  }

  createCollection(name, dimension, metric = 'cosine', seed = 42) {
    if (this.collections.has(name)) {
      throw new ConflictError(`collection ${name} already exists`);
    }
    const collection = new Collection({ name, dimension, metric, seed });
    this.collections.set(name, collection);
    return collection;
  }

  getCollection(name) {
    const collection = this.collections.get(name);
    if (!collection) throw new NotFoundError(`collection ${name} does not exist`);
    return collection;
  }

  hasCollection(name) {
    return this.collections.has(name);
  }

  listCollections() {
    return [...this.collections.values()].map((c) => ({
      name: c.name,
      dimension: c.dimension,
      metric: c.metric,
      size: c.size,
    }));
  }

  deleteCollection(name) {
    if (!this.collections.delete(name)) {
      throw new NotFoundError(`collection ${name} does not exist`);
    }
    return true;
  }

  applyOp(op) {
    switch (op.type) {
      case 'create-collection':
        return this.createCollection(op.name, op.dimension, op.metric, op.seed);
      case 'upsert':
        return this.getCollection(op.collection).upsert(op.id, op.vector, op.metadata ?? {});
      case 'delete-vector':
        return this.getCollection(op.collection).delete(op.id);
      case 'delete-collection':
        return this.deleteCollection(op.name);
      default:
        throw new ValidationError(`unknown op type ${op.type}`);
    }
  }

  toJSON() {
    return {
      version: 1,
      collections: [...this.collections.values()].map((c) => c.toJSON()),
    };
  }

  static fromJSON(data) {
    const store = new VectorStore();
    for (const collectionData of data.collections ?? []) {
      store.collections.set(collectionData.name, Collection.fromJSON(collectionData));
    }
    return store;
  }
}
