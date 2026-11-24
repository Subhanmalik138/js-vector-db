// Public entry point: everything a library user needs, nothing they don't.
export { VectorStore } from './store.js';
export { Collection } from './collection.js';
export { HnswIndex } from './hnsw.js';
export { Persistence, PersistentStore } from './persistence.js';
export { createServer } from './server.js';
export { distance, similarity, METRICS } from './distance.js';
export { matchFilter } from './filters.js';
export { ValidationError, NotFoundError, ConflictError } from './errors.js';
