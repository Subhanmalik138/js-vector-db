# VectorDB

A tiny vector database in zero-dependency Node.js. Create collections of
fixed-dimension vectors, search them by similarity, filter by metadata, and
have everything survive a restart.

Built for the use case every embeddings tutorial hand-waves past: you have a
few thousand vectors from an embedding model and you want nearest-neighbour
search, metadata filtering, and persistence — without standing up a
distributed system or pulling in a 200 MB dependency.

## Features

- **HNSW approximate search** — the same graph algorithm real vector
  databases use (Malkov & Yashunin, 2018), with a measured recall@10 of
  1.000 on 500 random 16-d vectors. Seeded RNG, so identical inserts build
  an identical graph.
- **Three metrics** — cosine, dot product, and Euclidean, per collection.
- **Metadata filters** — MongoDB-style queries (`$eq`, `$gt`, `$in`,
  `$contains`, `$and` / `$or`). Filtered search is exact brute force by
  design: a filter can leave too few candidates for a graph walk to be
  trustworthy.
- **Durable** — a write-ahead log plus periodic snapshots. Reopening replays
  the log; a torn final line (crash mid-append) is skipped, and a snapshot
  is written to a temp file and renamed so a crash mid-snapshot never
  corrupts the previous one.
- **Three ways in** — a library API, a REST server, and a CLI.

## Quick start

```bash
npm install   # no dependencies — this only links the local bin
npm test      # 39 tests

# CLI: create a collection, insert vectors, search
node cli/vectordb.js create movies 3
node cli/vectordb.js insert-file movies examples/movies.jsonl
node cli/vectordb.js search movies '[1, 0, 0]' --k 2

# Server: same store behind HTTP (default port 7373, data in ./data)
node cli/vectordb.js serve
curl -X POST localhost:7373/collections/movies/search \
  -d '{"vector": [1, 0, 0], "k": 2, "filter": {"genre": "sci-fi"}}'
```

## Library API

```js
import { VectorStore } from './src/index.js';

const store = new VectorStore();
const docs = store.createCollection('docs', 3, 'cosine');
docs.upsert('a', [1, 0, 0], { lang: 'en', score: 0.9 });
docs.upsert('b', [0, 1, 0], { lang: 'ur', score: 0.4 });

docs.search([1, 0, 0], { k: 2 });
// → [{ id: 'a', score: 1, metadata: { lang: 'en', score: 0.9 } }, ...]

docs.search([1, 0, 0], { filter: { score: { $gte: 0.8 } } });
```

For persistence, use `PersistentStore` — same API, plus a WAL and snapshots:

```js
import { PersistentStore } from './src/index.js';

const db = await PersistentStore.open('./data'); // replays WAL on open
await db.mutate({ type: 'create-collection', name: 'docs', dimension: 3 });
await db.mutate({ type: 'upsert', collection: 'docs', id: 'a', vector: [1, 0, 0] });
await db.snapshot(); // force a snapshot now
```

## HTTP API

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/health` | Status, collection and vector counts |
| `GET` | `/collections` | List collections |
| `PUT` | `/collections/:name` | Create (`{dimension, metric?, seed?}`) |
| `GET` / `DELETE` | `/collections/:name` | Info / delete collection |
| `POST` | `/collections/:name/vectors` | Upsert one vector or `{vectors: [...]}` batch |
| `GET` / `DELETE` | `/collections/:name/vectors/:id` | Fetch / delete one vector |
| `POST` | `/collections/:name/search` | `{vector, k?, filter?}` |
| `POST` | `/collections/:name/snapshot` | Force a snapshot |

Errors are typed: validation → `400`, unknown collection/vector → `404`,
duplicate collection → `409`.

## CLI reference

```
vectordb serve [--port 7373] [--host 127.0.0.1] [--data ./data]
vectordb create <name> <dimension> [--metric cosine] [--data ./data]
vectordb insert <collection> <id> <vector-json> [--meta {...}] [--data ./data]
vectordb insert-file <collection> <file.jsonl> [--data ./data]
vectordb search <collection> <vector-json> [--k 10] [--filter {...}] [--data ./data]
vectordb get <collection> <id> [--data ./data]
vectordb delete-vector <collection> <id> [--data ./data]
vectordb delete <collection> [--data ./data]
vectordb stats [--data ./data]
vectordb snapshot [--data ./data]
```

## Design decisions

1. **HNSW, but only when it earns its keep.** The graph is maintained on
   every insert, yet search uses it only for unfiltered queries on
   collections of 64+ vectors; below that a linear scan is faster and
   exact. Filtered search is always exact brute force (see Features).
2. **Cosine vectors are normalised at insert time.** A dot product then
   *is* the cosine similarity, so the brute-force path and the HNSW path
   can never disagree about ordering. The zero vector is rejected loudly
   instead of silently scoring `NaN`.
3. **One choke-point for mutations.** Every change — create, upsert,
   delete — goes through `VectorStore.applyOp`, which is exactly what the
   WAL records. The log and the in-memory state cannot drift apart, and
   replaying the log rebuilds the store bit for bit.
4. **Deletes are lazy tombstones.** HNSW has no clean delete, so deleted
   nodes are marked and skipped; once tombstones pass 25% of the live set
   the graph is rebuilt from the live vectors. Rebuilds are also what
   snapshot loading does, so the code path is exercised constantly.
5. **No authentication, on purpose.** This is a local-first embeddable
   database, not a multi-tenant service. Bind it to `127.0.0.1` (the
   default) and put a real proxy in front of it if you expose it.

## Project structure

```
src/
  collection.js    one collection: vectors, metadata, search dispatch
  distance.js      cosine / dot / euclidean, one contract for both paths
  filters.js       MongoDB-style metadata filter matching
  hnsw.js          HNSW graph: levels, neighbour heuristic, lazy deletes
  persistence.js   WAL + snapshots + crash recovery, PersistentStore
  server.js        zero-dependency HTTP API
  store.js         multi-collection store, applyOp choke-point
  rng.js           seeded PRNG for reproducible graphs
cli/vectordb.js    CLI (serve, create, insert, search, stats, ...)
tests/             39 node:test tests (distance, filters, collection,
                   HNSW recall, persistence recovery, HTTP)
```

## Testing

```bash
npm test   # node --test, no test framework dependency
```

The HNSW test asserts recall@10 ≥ 0.95 against brute force on 500 random
16-d vectors (measured 1.000), plus delete/rebuild behaviour, determinism
under a fixed seed, and persistence recovery from a torn WAL.

## Limitations

- Single node, single process; no replication or sharding.
- The whole index lives in memory — comfortable into the tens of thousands
  of vectors, not millions.
- No authentication on the HTTP API (see decision 5).
- Vectors are `float32`; `float64` precision is not preserved.

## License

MIT — see [LICENSE](LICENSE).
