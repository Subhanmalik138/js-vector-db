#!/usr/bin/env node
// vectordb — command-line client for VectorDB.
//
//   vectordb serve [--port 7373] [--host 127.0.0.1] [--data ./data]
//   vectordb create <name> <dimension> [--metric cosine] [--data ./data]
//   vectordb insert <collection> <id> <vector-json> [--meta {...}] [--data ./data]
//   vectordb insert-file <collection> <file.jsonl> [--data ./data]
//   vectordb search <collection> <vector-json> [--k 10] [--filter {...}] [--data ./data]
//   vectordb get <collection> <id> [--data ./data]
//   vectordb delete-vector <collection> <id> [--data ./data]
//   vectordb delete <collection> [--data ./data]
//   vectordb stats [--data ./data]
//   vectordb snapshot [--data ./data]
//
// Every command except `serve` opens the data directory, runs one operation
// and exits, so the CLI doubles as a scripting client for the same store
// the server keeps. Vectors are JSON arrays, e.g. "[0.1, 0.2, 0.3]".

import { promises as fs } from 'node:fs';
import { PersistentStore } from '../src/persistence.js';
import { createServer } from '../src/server.js';

const DEFAULT_DATA_DIR = './data';
const DEFAULT_PORT = 7373;

function usage() {
  console.log(`Usage:
  vectordb serve [--port ${DEFAULT_PORT}] [--host 127.0.0.1] [--data ${DEFAULT_DATA_DIR}]
  vectordb create <name> <dimension> [--metric cosine] [--data ${DEFAULT_DATA_DIR}]
  vectordb insert <collection> <id> <vector-json> [--meta {...}] [--data ${DEFAULT_DATA_DIR}]
  vectordb insert-file <collection> <file.jsonl> [--data ${DEFAULT_DATA_DIR}]
  vectordb search <collection> <vector-json> [--k 10] [--filter {...}] [--data ${DEFAULT_DATA_DIR}]
  vectordb get <collection> <id> [--data ${DEFAULT_DATA_DIR}]
  vectordb delete-vector <collection> <id> [--data ${DEFAULT_DATA_DIR}]
  vectordb delete <collection> [--data ${DEFAULT_DATA_DIR}]
  vectordb stats [--data ${DEFAULT_DATA_DIR}]
  vectordb snapshot [--data ${DEFAULT_DATA_DIR}]`);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      flags[key] = value;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON, got: ${value}`);
  }
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;
  const dataDir = flags.data ?? DEFAULT_DATA_DIR;

  if (!command || command === '--help' || command === 'help') {
    usage();
    return;
  }

  if (command === 'serve') {
    const port = Number(flags.port ?? DEFAULT_PORT);
    const host = flags.host ?? '127.0.0.1';
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail('--port must be an integer 1-65535');
    const persistent = await PersistentStore.open(dataDir);
    const { listen } = createServer(persistent, { host, port });
    const { host: boundHost, port: boundPort } = await listen();
    console.log(`VectorDB listening on http://${boundHost}:${boundPort} (data: ${dataDir})`);
    console.log(`replayed ${persistent.replayed} WAL ops, skipped ${persistent.skipped}`);
    return;
  }

  const persistent = await PersistentStore.open(dataDir);

  switch (command) {
    case 'create': {
      const [name, dimension] = rest;
      if (!name || !dimension) fail('create needs <name> <dimension>');
      await persistent.mutate({
        type: 'create-collection',
        name,
        dimension: Number(dimension),
        metric: flags.metric,
      });
      console.log(`created collection ${name} (dimension ${dimension}, metric ${flags.metric ?? 'cosine'})`);
      break;
    }
    case 'insert': {
      const [collection, id, vectorJson] = rest;
      if (!collection || !id || !vectorJson) fail('insert needs <collection> <id> <vector-json>');
      const result = await persistent.mutate({
        type: 'upsert',
        collection,
        id,
        vector: parseJson(vectorJson, 'vector'),
        metadata: flags.meta ? parseJson(flags.meta, '--meta') : {},
      });
      console.log(`${result.created ? 'inserted' : 'updated'} vector ${id} in ${collection}`);
      break;
    }
    case 'insert-file': {
      const [collection, file] = rest;
      if (!collection || !file) fail('insert-file needs <collection> <file.jsonl>');
      const text = await fs.readFile(file, 'utf8');
      const lines = text.split('\n').filter((line) => line.trim() !== '');
      let count = 0;
      for (const line of lines) {
        const item = parseJson(line, 'JSONL line');
        await persistent.mutate({
          type: 'upsert',
          collection,
          id: item.id,
          vector: item.vector,
          metadata: item.metadata ?? {},
        });
        count++;
      }
      console.log(`inserted ${count} vectors into ${collection}`);
      break;
    }
    case 'search': {
      const [collection, vectorJson] = rest;
      if (!collection || !vectorJson) fail('search needs <collection> <vector-json>');
      const results = persistent
        .getCollection(collection)
        .search(parseJson(vectorJson, 'vector'), {
          k: flags.k ? Number(flags.k) : 10,
          filter: flags.filter ? parseJson(flags.filter, '--filter') : null,
        });
      console.log(JSON.stringify(results, null, 2));
      break;
    }
    case 'get': {
      const [collection, id] = rest;
      if (!collection || !id) fail('get needs <collection> <id>');
      const vector = persistent.getCollection(collection).get(id);
      if (!vector) fail(`vector ${id} does not exist in ${collection}`);
      console.log(JSON.stringify(vector, null, 2));
      break;
    }
    case 'delete-vector': {
      const [collection, id] = rest;
      if (!collection || !id) fail('delete-vector needs <collection> <id>');
      const deleted = await persistent.mutate({ type: 'delete-vector', collection, id });
      console.log(deleted ? `deleted vector ${id}` : `vector ${id} did not exist`);
      break;
    }
    case 'delete': {
      const [collection] = rest;
      if (!collection) fail('delete needs <collection>');
      await persistent.mutate({ type: 'delete-collection', name: collection });
      console.log(`deleted collection ${collection}`);
      break;
    }
    case 'stats': {
      const collections = persistent.listCollections();
      console.log(JSON.stringify({ dataDir, collections, replayed: persistent.replayed, skipped: persistent.skipped }, null, 2));
      break;
    }
    case 'snapshot': {
      await persistent.snapshot();
      console.log(`snapshot written to ${dataDir}`);
      break;
    }
    default:
      fail(`unknown command: ${command}`);
  }
}

main().catch((err) => fail(err.message));
