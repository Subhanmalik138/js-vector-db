// HNSW (Hierarchical Navigable Small World) approximate nearest-neighbour
// index, after Malkov & Yashunin (2018). Zero dependencies, small-scale
// implementation: sorted arrays stand in for heaps, which is fine for the
// thousands-of-vectors collections this database targets.
//
// Design notes:
//   - Levels are drawn from a geometric distribution with mL = 1/ln(M).
//   - Neighbour selection uses the paper's diversity heuristic: a candidate
//     is kept only if it is closer to the new node than to any neighbour
//     already selected, which keeps the graph navigable instead of cliquey.
//   - Deletes are lazy tombstones. A deleted node is never returned and
//     never expanded during search; when tombstones pass 25% of the live
//     set (or 16, whichever is larger) the collection rebuilds the index.
//   - The RNG is seeded, so identical inserts build an identical graph.

import { distance, similarity } from './distance.js';
import { mulberry32 } from './rng.js';

export class HnswIndex {
  constructor({ dimension, metric = 'cosine', M = 16, efConstruction = 200, efSearch = 50, seed = 42 }) {
    this.dimension = dimension;
    this.metric = metric;
    this.M = M;
    this.Mmax = M;
    this.Mmax0 = M * 2;
    this.efConstruction = efConstruction;
    this.efSearch = efSearch;
    this.mL = 1 / Math.log(M);
    this.rng = mulberry32(seed);
    this.nodes = []; // { id, vector, level, neighbors: Set[] per level, deleted }
    this.idToNode = new Map(); // external id -> internal index (live nodes only)
    this.entryPoint = null;
    this.maxLevel = -1;
    this.deletedCount = 0;
  }

  get size() {
    return this.idToNode.size;
  }

  upsert(id, vector) {
    if (this.idToNode.has(id)) this.delete(id);
    this.#insert(id, vector);
  }

  delete(id) {
    const nodeIdx = this.idToNode.get(id);
    if (nodeIdx === undefined) return false;
    const node = this.nodes[nodeIdx];
    node.deleted = true;
    this.idToNode.delete(id);
    this.deletedCount++;
    if (nodeIdx === this.entryPoint) this.#replaceEntryPoint();
    return true;
  }

  // A deleted entry point would strand every search, so promote the live
  // node with the highest level (or clear the index if none is left).
  #replaceEntryPoint() {
    let best = null;
    let bestLevel = -1;
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      if (!node.deleted && node.level > bestLevel) {
        best = i;
        bestLevel = node.level;
      }
    }
    this.entryPoint = best;
    this.maxLevel = bestLevel;
  }

  rebuild(items) {
    this.nodes = [];
    this.idToNode = new Map();
    this.entryPoint = null;
    this.maxLevel = -1;
    this.deletedCount = 0;
    for (const { id, vector } of items) this.upsert(id, vector);
  }

  search(query, k, { ef = null } = {}) {
    if (this.entryPoint === null || this.idToNode.size === 0) return [];
    const efSearch = Math.max(ef ?? this.efSearch, k);
    let current = this.entryPoint;
    for (let level = this.maxLevel; level >= 1; level--) {
      current = this.#greedy(query, current, level);
    }
    const results = this.#searchLayer(query, [current], efSearch, 0);
    return results
      .filter((r) => !this.nodes[r.node].deleted)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, k)
      .map((r) => ({
        id: this.nodes[r.node].id,
        score: similarity(this.metric, query, this.nodes[r.node].vector),
      }));
  }

  #randomLevel() {
    const r = Math.max(this.rng(), 1e-12);
    return Math.floor(-Math.log(r) * this.mL);
  }

  #insert(id, vector) {
    const level = this.#randomLevel();
    const nodeIdx = this.nodes.length;
    const node = {
      id,
      vector,
      level,
      neighbors: Array.from({ length: level + 1 }, () => new Set()),
      deleted: false,
    };
    this.nodes.push(node);
    this.idToNode.set(id, nodeIdx);

    if (this.entryPoint === null) {
      this.entryPoint = nodeIdx;
      this.maxLevel = level;
      return;
    }

    let current = this.entryPoint;
    for (let l = this.maxLevel; l > level; l--) {
      current = this.#greedy(vector, current, l);
    }
    for (let l = Math.min(level, this.maxLevel); l >= 0; l--) {
      const candidates = this.#searchLayer(vector, [current], this.efConstruction, l);
      const cap = l === 0 ? this.Mmax0 : this.Mmax;
      const selected = this.#selectNeighbors(vector, candidates, cap);
      for (const neighbour of selected) {
        node.neighbors[l].add(neighbour);
        this.nodes[neighbour].neighbors[l].add(nodeIdx);
        if (this.nodes[neighbour].neighbors[l].size > cap) {
          this.nodes[neighbour].neighbors[l] = new Set(
            this.#selectNeighbors(
              this.nodes[neighbour].vector,
              [...this.nodes[neighbour].neighbors[l]].map((n) => ({
                node: n,
                dist: distance(this.metric, this.nodes[neighbour].vector, this.nodes[n].vector),
              })),
              cap,
            ),
          );
        }
      }
      // The closest candidate found on this layer seeds the next layer down.
      if (candidates.length > 0) current = candidates[candidates.length - 1].node;
    }
    if (level > this.maxLevel) {
      this.maxLevel = level;
      this.entryPoint = nodeIdx;
    }
  }

  // Greedy descent on one layer: walk to the closest neighbour until no
  // neighbour is closer. Returns the internal node index.
  #greedy(query, entry, level) {
    let current = entry;
    let currentDist = distance(this.metric, query, this.nodes[current].vector);
    let improved = true;
    while (improved) {
      improved = false;
      for (const neighbour of this.nodes[current].neighbors[level] ?? []) {
        const neighbourNode = this.nodes[neighbour];
        if (neighbourNode.deleted) continue;
        const d = distance(this.metric, query, neighbourNode.vector);
        if (d < currentDist) {
          currentDist = d;
          current = neighbour;
          improved = true;
        }
      }
    }
    return current;
  }

  // Best-first layer search. `results` is kept sorted worst-first (largest
  // distance at index 0) and capped at ef; `candidates` is sorted
  // best-first. Returns results sorted worst-first; callers re-sort.
  #searchLayer(query, entryPoints, ef, level) {
    const visited = new Set(entryPoints);
    const candidates = entryPoints.map((i) => ({
      node: i,
      dist: distance(this.metric, query, this.nodes[i].vector),
    }));
    candidates.sort((a, b) => a.dist - b.dist);
    const results = [...candidates];
    results.sort((a, b) => b.dist - a.dist);

    while (candidates.length > 0) {
      const current = candidates.shift(); // closest unexplored candidate
      if (results.length >= ef && current.dist > results[0].dist) break;
      for (const neighbour of this.nodes[current.node].neighbors[level] ?? []) {
        if (visited.has(neighbour)) continue;
        visited.add(neighbour);
        const neighbourNode = this.nodes[neighbour];
        if (neighbourNode.deleted) continue;
        const d = distance(this.metric, query, neighbourNode.vector);
        if (results.length < ef || d < results[0].dist) {
          candidates.push({ node: neighbour, dist: d });
          candidates.sort((a, b) => a.dist - b.dist);
          results.push({ node: neighbour, dist: d });
          results.sort((a, b) => b.dist - a.dist);
          if (results.length > ef) results.shift(); // drop the worst
        }
      }
    }
    return results;
  }

  // The paper's SELECT-NEIGHBORS heuristic: prefer candidates that are
  // closer to the query node than to any neighbour already selected, then
  // fill any remaining slots with the closest leftovers.
  #selectNeighbors(query, candidates, M) {
    const sorted = [...candidates].sort((a, b) => a.dist - b.dist);
    const selected = [];
    for (const candidate of sorted) {
      if (selected.length >= M) break;
      let keep = true;
      for (const kept of selected) {
        if (
          distance(this.metric, this.nodes[candidate.node].vector, this.nodes[kept].vector) <
          candidate.dist
        ) {
          keep = false;
          break;
        }
      }
      if (keep) selected.push(candidate.node);
    }
    if (selected.length < M) {
      for (const candidate of sorted) {
        if (selected.length >= M) break;
        if (!selected.includes(candidate.node)) selected.push(candidate.node);
      }
    }
    return selected;
  }
}
