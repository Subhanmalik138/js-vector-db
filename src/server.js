// HTTP API over the zero-dependency Node http module. Every route is thin:
// parse the body, translate to one store op, serialise the result. Errors
// from the store map to status codes by type, so clients never see a stack
// trace and never have to guess what went wrong.
//
//   GET    /health                                  server + store stats
//   GET    /collections                             list collections
//   PUT    /collections/:name        {dimension, metric?, seed?}
//   GET    /collections/:name                       collection info
//   DELETE /collections/:name
//   POST   /collections/:name/vectors               {id, vector, metadata?}
//                                            or    {vectors: [{id, vector, metadata?}]}
//   GET    /collections/:name/vectors/:id
//   DELETE /collections/:name/vectors/:id
//   POST   /collections/:name/search                {vector, k?, filter?}
//   POST   /collections/:name/snapshot              force a snapshot now

import http from 'node:http';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';

const MAX_BODY_BYTES = 1024 * 1024;

function statusFor(err) {
  if (err instanceof ValidationError) return 400;
  if (err instanceof NotFoundError) return 404;
  if (err instanceof ConflictError) return 409;
  return 500;
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new ValidationError(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ValidationError('request body must be valid JSON');
  }
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new ValidationError(`bad URL segment: ${segment}`);
  }
}

export function createServer(persistentStore, { host = '127.0.0.1', port = 7373 } = {}) {
  const store = persistentStore.store;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const segments = url.pathname.split('/').filter(Boolean).map(decodeSegment);
      const method = req.method;

      if (method === 'GET' && segments.length === 1 && segments[0] === 'health') {
        const collections = store.listCollections();
        return send(res, 200, {
          status: 'ok',
          collections: collections.length,
          vectors: collections.reduce((sum, c) => sum + c.size, 0),
          dataDir: persistentStore.dataDir,
        });
      }

      if (method === 'GET' && segments.length === 1 && segments[0] === 'collections') {
        return send(res, 200, { collections: store.listCollections() });
      }

      if (segments.length >= 2 && segments[0] === 'collections') {
        const name = segments[1];
        const collection = () => store.getCollection(name);

        if (method === 'PUT' && segments.length === 2) {
          const body = await readJsonBody(req);
          await persistentStore.mutate({
            type: 'create-collection',
            name,
            dimension: body.dimension,
            metric: body.metric,
            seed: body.seed,
          });
          return send(res, 201, { collection: collectionInfo(collection()) });
        }
        if (method === 'GET' && segments.length === 2) {
          return send(res, 200, { collection: collectionInfo(collection()) });
        }
        if (method === 'DELETE' && segments.length === 2) {
          await persistentStore.mutate({ type: 'delete-collection', name });
          return send(res, 200, { deleted: name });
        }
        if (method === 'POST' && segments.length === 3 && segments[2] === 'vectors') {
          const body = await readJsonBody(req);
          const items = Array.isArray(body.vectors)
            ? body.vectors
            : [{ id: body.id, vector: body.vector, metadata: body.metadata }];
          const results = [];
          for (const item of items) {
            results.push(
              await persistentStore.mutate({
                type: 'upsert',
                collection: name,
                id: item.id,
                vector: item.vector,
                metadata: item.metadata ?? {},
              }),
            );
          }
          return send(res, 200, { upserted: results });
        }
        if (method === 'GET' && segments.length === 4 && segments[2] === 'vectors') {
          const vector = collection().get(segments[3]);
          if (!vector) throw new NotFoundError(`vector ${segments[3]} does not exist in ${name}`);
          return send(res, 200, { vector });
        }
        if (method === 'DELETE' && segments.length === 4 && segments[2] === 'vectors') {
          const deleted = await persistentStore.mutate({
            type: 'delete-vector',
            collection: name,
            id: segments[3],
          });
          if (!deleted) throw new NotFoundError(`vector ${segments[3]} does not exist in ${name}`);
          return send(res, 200, { deleted: segments[3] });
        }
        if (method === 'POST' && segments.length === 3 && segments[2] === 'search') {
          const body = await readJsonBody(req);
          const results = collection().search(body.vector, { k: body.k ?? 10, filter: body.filter ?? null });
          return send(res, 200, { results });
        }
        if (method === 'POST' && segments.length === 3 && segments[2] === 'snapshot') {
          await persistentStore.snapshot();
          return send(res, 200, { snapshotted: name });
        }
      }

      return send(res, 404, { error: `no route for ${method} ${url.pathname}` });
    } catch (err) {
      return send(res, statusFor(err), { error: err.message });
    }
  });

  return {
    server,
    listen() {
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve({ host, port }));
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function collectionInfo(collection) {
  return {
    name: collection.name,
    dimension: collection.dimension,
    metric: collection.metric,
    size: collection.size,
  };
}
