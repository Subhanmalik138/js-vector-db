// Durability: a write-ahead log (one JSON op per line) plus periodic full
// snapshots. The store is rebuilt by loading the latest snapshot and
// replaying the WAL on top of it.
//
// Crash cases this handles:
//   - Crash mid-append: the torn final line is not valid JSON and is
//     skipped on replay; every complete line before it still applies.
//   - Crash between snapshot write and WAL truncate: ops already in the
//     snapshot are replayed a second time. Replaying a create for an
//     existing collection (or a delete for a missing vector) is a no-op
//     conflict, counted as `skipped`, never a crash.
//   - Crash mid-snapshot: the snapshot is written to a temp file and
//     renamed, so the previous snapshot stays intact.
//
// Mutation order is apply-then-log: a mutation that fails validation never
// reaches the log, so the WAL only ever contains ops the store accepted.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { VectorStore } from './store.js';
import { ConflictError, NotFoundError } from './errors.js';

const SNAPSHOT_FILE = 'snapshot.json';
const WAL_FILE = 'wal.jsonl';

export class Persistence {
  constructor(dataDir, { autoSnapshotOps = 1000 } = {}) {
    this.dataDir = dataDir;
    this.autoSnapshotOps = autoSnapshotOps;
    this.walOps = 0;
  }

  async open() {
    await fs.mkdir(this.dataDir, { recursive: true });
    let store = new VectorStore();
    const snapshotPath = path.join(this.dataDir, SNAPSHOT_FILE);
    try {
      store = VectorStore.fromJSON(JSON.parse(await fs.readFile(snapshotPath, 'utf8')));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    const walPath = path.join(this.dataDir, WAL_FILE);
    let wal = '';
    try {
      wal = await fs.readFile(walPath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    let replayed = 0;
    let skipped = 0;
    const lines = wal.split('\n').filter((line) => line.trim() !== '');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let op;
      try {
        op = JSON.parse(line);
      } catch {
        // A torn final line means the process died mid-append; anything
        // before it is intact, so only the tail may be dropped.
        if (i === lines.length - 1) {
          skipped++;
          continue;
        }
        throw new Error(`corrupt WAL line ${i + 1}: ${line.slice(0, 80)}`);
      }
      try {
        store.applyOp(op);
        replayed++;
      } catch (err) {
        if (err instanceof ConflictError || err instanceof NotFoundError) {
          // Op already reflected in the snapshot (crash between snapshot
          // and WAL truncate) or superseded; safe to skip.
          skipped++;
        } else {
          throw err;
        }
      }
    }
    this.walOps = replayed;
    return { store, replayed, skipped };
  }

  async append(op) {
    await fs.appendFile(path.join(this.dataDir, WAL_FILE), JSON.stringify(op) + '\n', 'utf8');
    this.walOps++;
  }

  async snapshot(store) {
    const tmpPath = path.join(this.dataDir, SNAPSHOT_FILE + '.tmp');
    await fs.writeFile(tmpPath, JSON.stringify(store.toJSON()), 'utf8');
    await fs.rename(tmpPath, path.join(this.dataDir, SNAPSHOT_FILE));
    await fs.writeFile(path.join(this.dataDir, WAL_FILE), '', 'utf8');
    this.walOps = 0;
  }

  async maybeSnapshot(store) {
    if (this.walOps >= this.autoSnapshotOps) await this.snapshot(store);
  }
}

// A store whose mutations are durably logged. Reads go straight to the
// in-memory store; writes apply in memory, append to the WAL, and trigger
// an automatic snapshot once the log grows past the threshold.
export class PersistentStore {
  constructor(dataDir, options = {}) {
    this.persistence = new Persistence(dataDir, options);
    this.store = new VectorStore();
    this.replayed = 0;
    this.skipped = 0;
  }

  static async open(dataDir, options = {}) {
    const persistent = new PersistentStore(dataDir, options);
    const { store, replayed, skipped } = await persistent.persistence.open();
    persistent.store = store;
    persistent.replayed = replayed;
    persistent.skipped = skipped;
    return persistent;
  }

  async mutate(op) {
    const result = this.store.applyOp(op);
    await this.persistence.append(op);
    await this.persistence.maybeSnapshot(this.store);
    return result;
  }

  async snapshot() {
    await this.persistence.snapshot(this.store);
  }

  get dataDir() {
    return this.persistence.dataDir;
  }

  listCollections() {
    return this.store.listCollections();
  }

  getCollection(name) {
    return this.store.getCollection(name);
  }

  hasCollection(name) {
    return this.store.hasCollection(name);
  }
}
