#!/usr/bin/env node
// octobots-pack-version: 48

// src/cli.ts
import { mkdirSync as mkdirSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join9, relative as relative3 } from "node:path";

// src/harvest.ts
import { execFileSync } from "node:child_process";

// src/noise.ts
function isTestPath(path) {
  const segments = path.split("/");
  const filename = segments[segments.length - 1] ?? "";
  const testSegment = /^(test|tests|__tests__)$/;
  if (segments.some((s) => testSegment.test(s))) return true;
  if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(filename)) return true;
  if (/^test_.+\.py$/.test(filename) || /_test\.py$/.test(filename)) return true;
  if (filename === "conftest.py") return true;
  if (/_test\.go$/.test(filename)) return true;
  return false;
}
function isExcludedPath(path, excludePaths) {
  for (const raw of excludePaths) {
    const prefix = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    if (prefix.length === 0) continue;
    if (path === prefix || path.startsWith(`${prefix}/`)) return true;
  }
  return false;
}
var LOCK_PAIRS = [
  [/(^|\/)package\.json$/, /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/],
  [/(^|\/)Cargo\.toml$/, /(^|\/)Cargo\.lock$/],
  [/(^|\/)pyproject\.toml$/, /(^|\/)(uv\.lock|poetry\.lock)$/],
  [/(^|\/)go\.mod$/, /(^|\/)go\.sum$/],
  [/(^|\/)Gemfile$/, /(^|\/)Gemfile\.lock$/]
];
function directoryOf(path) {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}
function governs(lockDir, manifestDir) {
  return lockDir === "" || lockDir === manifestDir || manifestDir.startsWith(`${lockDir}/`);
}
function classifyPair(a, b) {
  const dirA = directoryOf(a);
  const dirB = directoryOf(b);
  for (const [manifest, lock] of LOCK_PAIRS) {
    if (manifest.test(a) && lock.test(b) && governs(dirB, dirA)) return "mechanical";
    if (manifest.test(b) && lock.test(a) && governs(dirA, dirB)) return "mechanical";
  }
  if (isTestPath(a) || isTestPath(b)) return "test-subject";
  return "candidate";
}

// src/harvest.ts
var RECORD = "\0";
var HEADER = /^[0-9a-f]{40} \d+$/;
function headerEnd(block) {
  const nl = block.indexOf("\n");
  const nul = block.indexOf("\0");
  if (nl < 0) return nul;
  if (nul < 0) return nl;
  return Math.min(nl, nul);
}
function harvest(repoRoot, opts = {}) {
  const maxFiles = opts.maxCommitFiles ?? 50;
  const exclude = opts.excludePaths ?? [];
  const args = ["log", "--no-merges", "--name-only", "-z", "--pretty=format:%x00%x1e%H %at"];
  if (opts.since) args.push(`--since=${opts.since}`);
  const raw = execFileSync("git", args, {
    cwd: repoRoot,
    maxBuffer: 1 << 28,
    encoding: "utf8"
  });
  const out = [];
  for (const block of raw.split(RECORD)) {
    const end = headerEnd(block);
    if (end < 0) continue;
    const header = block.slice(0, end);
    const [sha, at] = header.split(" ");
    if (sha === void 0 || at === void 0 || !HEADER.test(header)) continue;
    const all = [...new Set(block.slice(end + 1).split("\0").filter((p) => p.length > 0))];
    const files = exclude.length === 0 ? all : all.filter((p) => !isExcludedPath(p, exclude));
    if (files.length < 2 || files.length > maxFiles) continue;
    out.push({ sha, files, timestamp: Number(at) * 1e3 });
  }
  return out;
}
var SQUASH_SUBJECT = /\(#\d+\)$/;
function squashShape(repoRoot, opts = {}) {
  const args = ["log", "--no-merges", "--format=%H %s"];
  if (opts.since) args.push(`--since=${opts.since}`);
  const raw = execFileSync("git", args, { cwd: repoRoot, maxBuffer: 1 << 28, encoding: "utf8" });
  const squashedShas = /* @__PURE__ */ new Set();
  let total = 0;
  for (const line of raw.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    total += 1;
    if (SQUASH_SUBJECT.test(line.slice(sp + 1).trim())) squashedShas.add(line.slice(0, sp));
  }
  const sized = new Set(
    harvest(repoRoot, { ...opts, maxCommitFiles: Number.MAX_SAFE_INTEGER }).map((c) => c.sha)
  );
  const kept = new Set(harvest(repoRoot, opts).map((c) => c.sha));
  let droppedSquash = 0;
  for (const sha of squashedShas) if (sized.has(sha) && !kept.has(sha)) droppedSquash += 1;
  return {
    total,
    squashed: squashedShas.size,
    droppedSquash,
    dominated: squashedShas.size * 2 > total
  };
}
function isIgnored(repoRoot, path) {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", path], { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// src/cochange.ts
var MS_PER_DAY = 864e5;
function countPairs(commits, opts) {
  const halfLife = opts.halfLifeDays ?? 180;
  if (!Number.isFinite(halfLife) || halfLife <= 0) {
    throw new RangeError(
      `halfLifeDays must be a finite number greater than 0, got ${String(opts.halfLifeDays)}`
    );
  }
  if (!Number.isFinite(opts.now)) {
    throw new RangeError(`now must be a finite epoch-ms timestamp, got ${String(opts.now)}`);
  }
  const lambda = Math.LN2 / (halfLife * MS_PER_DAY);
  const ids = /* @__PURE__ */ new Map();
  const files = [];
  const single = [];
  const singleWeight = [];
  const pairs = /* @__PURE__ */ new Map();
  let weightTotal = 0;
  const idOf = (path) => {
    let id = ids.get(path);
    if (id === void 0) {
      id = files.length;
      ids.set(path, id);
      files.push(path);
      single.push(0);
      singleWeight.push(0);
    }
    return id;
  };
  for (const c of commits) {
    if (!Number.isFinite(c.timestamp)) {
      throw new RangeError(
        `commit ${c.sha} has a non-finite timestamp: ${String(c.timestamp)}`
      );
    }
    const age = Math.max(0, opts.now - c.timestamp);
    const decay = Math.exp(-lambda * age);
    weightTotal += decay;
    const list = [...new Set(c.files.map((p) => idOf(p)))].sort((a, b) => a - b);
    for (const i of list) {
      single[i] = (single[i] ?? 0) + 1;
      singleWeight[i] = (singleWeight[i] ?? 0) + decay;
    }
    for (let x = 0; x < list.length; x++) {
      const i = list[x];
      if (i === void 0) continue;
      let row = pairs.get(i);
      if (!row) pairs.set(i, row = /* @__PURE__ */ new Map());
      for (let y = x + 1; y < list.length; y++) {
        const j = list[y];
        if (j === void 0) continue;
        const stat = row.get(j);
        if (stat) {
          stat.support += 1;
          stat.weight += decay;
        } else {
          row.set(j, { support: 1, weight: decay });
        }
      }
    }
  }
  return { files, single, singleWeight, pairs, commitCount: commits.length, weightTotal };
}

// src/weights.ts
function weighEdges(table, opts = {}) {
  const minSupport = opts.minSupport ?? 2;
  const out = [];
  const total = table.weightTotal;
  if (table.commitCount === 0 || !(total > 0)) return out;
  for (const [i, row] of table.pairs) {
    for (const [j, stat] of row) {
      if (stat.support < minSupport) continue;
      const wi = table.singleWeight[i];
      const wj = table.singleWeight[j];
      if (wi === void 0 || wj === void 0) continue;
      const pab = stat.weight / total;
      const pa = wi / total;
      const pb = wj / total;
      if (!(pab > 0) || !(pa > 0) || !(pb > 0)) continue;
      const pmi = Math.log(pab / (pa * pb));
      const denom = -Math.log(pab);
      const npmi = denom === 0 ? 1 : clamp(pmi / denom, -1, 1);
      out.push({
        a: i,
        b: j,
        support: stat.support,
        npmi,
        confidence: clamp(Math.min(stat.weight / wi, stat.weight / wj), 0, 1)
      });
    }
  }
  out.sort((x, y) => y.npmi - x.npmi || x.a - y.a || x.b - y.b);
  return out;
}
function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}
function edgeWeight(edge) {
  return edge.npmi > 0 ? edge.npmi : 0;
}

// src/hubs.ts
function detectHubs(edges, fileCount, opts = {}) {
  const z = opts.zThreshold ?? 3;
  const hubs = /* @__PURE__ */ new Set();
  if (fileCount < 3) return hubs;
  const strength = new Array(fileCount).fill(0);
  for (const e of edges) {
    const w = edgeWeight(e);
    strength[e.a] = (strength[e.a] ?? 0) + w;
    strength[e.b] = (strength[e.b] ?? 0) + w;
  }
  const mean = strength.reduce((a, b) => a + b, 0) / fileCount;
  const variance = strength.reduce((acc, s) => acc + (s - mean) ** 2, 0) / fileCount;
  const sd = Math.sqrt(variance);
  if (sd === 0) return hubs;
  strength.forEach((s, i) => {
    if ((s - mean) / sd > z) hubs.add(i);
  });
  return hubs;
}

// src/components.ts
var BRIDGE_WEIGHT = 0.01;
function findComponents(edges, nodes) {
  const adj = /* @__PURE__ */ new Map();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) {
    adj.get(e.a)?.push(e.b);
    adj.get(e.b)?.push(e.a);
  }
  const seen = /* @__PURE__ */ new Set();
  const comps = [];
  for (const start of nodes) {
    if (seen.has(start)) continue;
    const comp = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const n = stack.pop();
      if (n === void 0) continue;
      comp.push(n);
      for (const nb of adj.get(n) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    comps.push(comp.sort((a, b) => a - b));
  }
  comps.sort((a, b) => b.length - a.length || (a[0] ?? 0) - (b[0] ?? 0));
  return comps;
}
var dirOf = (p) => p.split("/").slice(0, -1).join("/");
function dirHistogram(comp, files) {
  const hist = /* @__PURE__ */ new Map();
  for (const n of comp) {
    const path = files[n];
    if (path === void 0) continue;
    const parts = dirOf(path).split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      hist.set(prefix, (hist.get(prefix) ?? 0) + 1);
    }
  }
  return hist;
}
function similarity(a, b) {
  let score = 0;
  for (const [k, v] of a) score += Math.min(v, b.get(k) ?? 0);
  return score;
}
function isSyntheticBridge(e) {
  return e.support === 0;
}
function bridgeComponents(edges, files) {
  const nodes = [...new Set(edges.flatMap((e) => [e.a, e.b]))].sort((a, b) => a - b);
  const linked = edges.filter((e) => edgeWeight(e) > 0);
  const comps = findComponents(linked, nodes);
  if (comps.length <= 1) return edges;
  const hists = comps.map((c) => dirHistogram(c, files));
  const out = [...edges];
  for (let i = 1; i < comps.length; i++) {
    const comp = comps[i];
    const hist = hists[i];
    if (!comp || !hist) continue;
    let bestIdx = 0;
    let bestScore = -1;
    for (let j = 0; j < i; j++) {
      const other = hists[j];
      if (!other) continue;
      const score = similarity(hist, other);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = j;
      }
    }
    const target = comps[bestIdx];
    const from = comp[0];
    const to = target?.[0];
    if (from === void 0 || to === void 0) continue;
    out.push({
      a: Math.min(from, to),
      b: Math.max(from, to),
      support: 0,
      // synthetic: no commit backs this edge
      npmi: BRIDGE_WEIGHT,
      confidence: 0
    });
  }
  return out;
}

// src/louvain.ts
function autoResolution(nodeCount) {
  if (nodeCount < 2) return 1;
  return Math.max(0.3, 1 - 0.2 * Math.log10(nodeCount));
}
function louvain(edges, opts = {}) {
  const exclude = opts.exclude ?? /* @__PURE__ */ new Set();
  const kept = edges.filter((e) => !exclude.has(e.a) && !exclude.has(e.b));
  const nodes = [...new Set(kept.flatMap((e) => [e.a, e.b]))].sort((a, b) => a - b);
  const community = /* @__PURE__ */ new Map();
  nodes.forEach((n) => community.set(n, n));
  if (nodes.length === 0) return community;
  const gamma = opts.resolution ?? autoResolution(nodes.length);
  const maxPasses = opts.maxPasses ?? 20;
  const adj = /* @__PURE__ */ new Map();
  const strength = /* @__PURE__ */ new Map();
  let totalWeight = 0;
  for (const e of kept) {
    const w = edgeWeight(e);
    if (w === 0) continue;
    for (const [u, v] of [[e.a, e.b], [e.b, e.a]]) {
      let row = adj.get(u);
      if (!row) adj.set(u, row = /* @__PURE__ */ new Map());
      row.set(v, (row.get(v) ?? 0) + w);
      strength.set(u, (strength.get(u) ?? 0) + w);
    }
    totalWeight += w;
  }
  if (totalWeight === 0) return community;
  const m2 = 2 * totalWeight;
  const commStrength = /* @__PURE__ */ new Map();
  for (const n of nodes) commStrength.set(n, strength.get(n) ?? 0);
  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false;
    for (const n of nodes) {
      const own2 = community.get(n);
      if (own2 === void 0) continue;
      const kn = strength.get(n) ?? 0;
      const into = /* @__PURE__ */ new Map();
      for (const [nb, w] of adj.get(n) ?? []) {
        const c = community.get(nb);
        if (c === void 0 || nb === n) continue;
        into.set(c, (into.get(c) ?? 0) + w);
      }
      commStrength.set(own2, (commStrength.get(own2) ?? 0) - kn);
      let best = own2;
      let bestGain = (into.get(own2) ?? 0) - gamma * kn * (commStrength.get(own2) ?? 0) / m2;
      for (const [c, wIn] of into) {
        if (c === own2) continue;
        const gain = wIn - gamma * kn * (commStrength.get(c) ?? 0) / m2;
        if (gain > bestGain + 1e-12 || Math.abs(gain - bestGain) <= 1e-12 && c < best) {
          best = c;
          bestGain = gain;
        }
      }
      commStrength.set(best, (commStrength.get(best) ?? 0) + kn);
      if (best !== own2) {
        community.set(n, best);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return community;
}

// src/rollup.ts
function pageRank(edges, nodes, damping = 0.85, iterations = 40) {
  const adj = /* @__PURE__ */ new Map();
  const strength = /* @__PURE__ */ new Map();
  for (const n2 of nodes) adj.set(n2, []);
  for (const e of edges) {
    const fromAdj = adj.get(e.a);
    const toAdj = adj.get(e.b);
    if (fromAdj === void 0 || toAdj === void 0) continue;
    const w = edgeWeight(e);
    if (w === 0) continue;
    fromAdj.push([e.b, w]);
    toAdj.push([e.a, w]);
    strength.set(e.a, (strength.get(e.a) ?? 0) + w);
    strength.set(e.b, (strength.get(e.b) ?? 0) + w);
  }
  const n = nodes.length;
  let rank2 = new Map(nodes.map((x) => [x, 1 / n]));
  for (let it = 0; it < iterations; it++) {
    const next = new Map(nodes.map((x) => [x, (1 - damping) / n]));
    for (const node of nodes) {
      const share = (rank2.get(node) ?? 0) * damping;
      const total = strength.get(node) ?? 0;
      if (total === 0) {
        for (const other of nodes) next.set(other, (next.get(other) ?? 0) + share / n);
        continue;
      }
      for (const [nb, w] of adj.get(node) ?? []) {
        next.set(nb, (next.get(nb) ?? 0) + share * w / total);
      }
    }
    rank2 = next;
  }
  return rank2;
}
function modulePageRank(edges, modules, damping = 0.85, iterations = 40) {
  const adj = /* @__PURE__ */ new Map();
  const strength = /* @__PURE__ */ new Map();
  for (const m of modules) adj.set(m, []);
  for (const e of edges) {
    const fromAdj = adj.get(e.from);
    const toAdj = adj.get(e.to);
    if (fromAdj === void 0 || toAdj === void 0) continue;
    if (e.weight === 0) continue;
    fromAdj.push([e.to, e.weight]);
    toAdj.push([e.from, e.weight]);
    strength.set(e.from, (strength.get(e.from) ?? 0) + e.weight);
    strength.set(e.to, (strength.get(e.to) ?? 0) + e.weight);
  }
  const n = modules.length;
  let rank2 = new Map(modules.map((x) => [x, 1 / n]));
  for (let it = 0; it < iterations; it++) {
    const next = new Map(modules.map((x) => [x, (1 - damping) / n]));
    for (const node of modules) {
      const share = (rank2.get(node) ?? 0) * damping;
      const total = strength.get(node) ?? 0;
      if (total === 0) {
        for (const other of modules) next.set(other, (next.get(other) ?? 0) + share / n);
        continue;
      }
      for (const [nb, w] of adj.get(node) ?? []) {
        next.set(nb, (next.get(nb) ?? 0) + share * w / total);
      }
    }
    rank2 = next;
  }
  return rank2;
}
function nameCluster(members, edges, files, k = 5) {
  const inside = new Set(members);
  const sub = edges.filter((e) => inside.has(e.a) && inside.has(e.b));
  const pr = pageRank(sub, members);
  return [...members].sort((a, b) => (pr.get(b) ?? 0) - (pr.get(a) ?? 0) || a - b).slice(0, k).map((id) => files[id]).filter((p) => p !== void 0);
}
function rollUp(edges, files, moduleOf) {
  const acc = /* @__PURE__ */ new Map();
  for (const e of edges) {
    const weight = edgeWeight(e);
    if (weight === 0) continue;
    const pa = files[e.a];
    const pb = files[e.b];
    if (pa === void 0 || pb === void 0) continue;
    const ma = moduleOf(pa);
    const mb = moduleOf(pb);
    if (ma === mb) continue;
    const [from, to] = ma < mb ? [ma, mb] : [mb, ma];
    const key = `${from}\0${to}`;
    const existing = acc.get(key);
    if (existing) existing.weight += weight;
    else acc.set(key, { from, to, weight });
  }
  return [...acc.values()].sort(
    (x, y) => y.weight - x.weight || compare(x.from, y.from) || compare(x.to, y.to)
  );
}
function compare(x, y) {
  return x < y ? -1 : x > y ? 1 : 0;
}

// src/spine.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, readdirSync, statSync } from "node:fs";
import { join as join3 } from "node:path";

// ../../node_modules/.pnpm/js-yaml@5.2.2/node_modules/js-yaml/dist/js-yaml.mjs
var NOT_RESOLVED = Symbol("NOT_RESOLVED");
var MERGE_KEY = Symbol("MERGE_KEY");
function defineScalarTag(tagName, options) {
  return {
    tagName,
    nodeKind: "scalar",
    implicit: options.implicit ?? false,
    matchByTagPrefix: options.matchByTagPrefix ?? false,
    implicitFirstChars: options.implicitFirstChars ?? null,
    resolve: options.resolve,
    identify: options.identify ?? null,
    represent: options.represent ?? ((data) => String(data)),
    representTagName: options.representTagName ?? null
  };
}
function defineSequenceTag(tagName, options) {
  const carrierIsResult = options.finalize === void 0;
  return {
    tagName,
    nodeKind: "sequence",
    implicit: false,
    matchByTagPrefix: options.matchByTagPrefix ?? false,
    create: options.create,
    addItem: options.addItem,
    finalize: options.finalize ?? ((carrier) => carrier),
    carrierIsResult,
    identify: options.identify ?? null,
    represent: options.represent ?? ((data) => data),
    representTagName: options.representTagName ?? null
  };
}
function defineMappingTag(tagName, options) {
  const carrierIsResult = options.finalize === void 0;
  return {
    tagName,
    nodeKind: "mapping",
    implicit: false,
    matchByTagPrefix: options.matchByTagPrefix ?? false,
    create: options.create,
    addPair: options.addPair,
    has: options.has,
    keys: options.keys,
    get: options.get,
    finalize: options.finalize ?? ((carrier) => carrier),
    carrierIsResult,
    identify: options.identify ?? null,
    represent: options.represent ?? ((data) => data),
    representTagName: options.representTagName ?? null
  };
}
var strTag = defineScalarTag("tag:yaml.org,2002:str", {
  resolve: (source) => source,
  identify: (data) => typeof data === "string"
});
var NULL_VALUES$1 = [
  "",
  "~",
  "null",
  "Null",
  "NULL"
];
var nullCoreTag = defineScalarTag("tag:yaml.org,2002:null", {
  implicit: true,
  implicitFirstChars: [
    "",
    "~",
    "n",
    "N"
  ],
  resolve: (source) => {
    if (NULL_VALUES$1.indexOf(source) !== -1) return null;
    return NOT_RESOLVED;
  },
  identify: (object) => object === null,
  represent: () => "null"
});
var nullJsonTag = defineScalarTag("tag:yaml.org,2002:null", {
  implicit: true,
  implicitFirstChars: ["n"],
  resolve: (source, isExplicit) => {
    if (source === "null" || isExplicit && source === "") return null;
    return NOT_RESOLVED;
  },
  identify: (object) => object === null,
  represent: () => "null"
});
var NULL_VALUES = [
  "",
  "~",
  "null",
  "Null",
  "NULL"
];
var nullYaml11Tag = defineScalarTag("tag:yaml.org,2002:null", {
  implicit: true,
  implicitFirstChars: [
    "",
    "~",
    "n",
    "N"
  ],
  resolve: (source) => {
    if (NULL_VALUES.indexOf(source) !== -1) return null;
    return NOT_RESOLVED;
  },
  identify: (object) => object === null,
  represent: () => "null"
});
var TRUE_VALUES$2 = [
  "true",
  "True",
  "TRUE"
];
var FALSE_VALUES$2 = [
  "false",
  "False",
  "FALSE"
];
var boolCoreTag = defineScalarTag("tag:yaml.org,2002:bool", {
  implicit: true,
  implicitFirstChars: [
    "t",
    "T",
    "f",
    "F"
  ],
  resolve: (source) => {
    if (TRUE_VALUES$2.indexOf(source) !== -1) return true;
    if (FALSE_VALUES$2.indexOf(source) !== -1) return false;
    return NOT_RESOLVED;
  },
  identify: (object) => Object.prototype.toString.call(object) === "[object Boolean]",
  represent: (object) => object ? "true" : "false"
});
var TRUE_VALUES$1 = ["true"];
var FALSE_VALUES$1 = ["false"];
var boolJsonTag = defineScalarTag("tag:yaml.org,2002:bool", {
  implicit: true,
  implicitFirstChars: ["t", "f"],
  resolve: (source) => {
    if (TRUE_VALUES$1.indexOf(source) !== -1) return true;
    if (FALSE_VALUES$1.indexOf(source) !== -1) return false;
    return NOT_RESOLVED;
  },
  identify: (object) => Object.prototype.toString.call(object) === "[object Boolean]",
  represent: (object) => object ? "true" : "false"
});
var TRUE_VALUES = [
  "true",
  "True",
  "TRUE",
  "y",
  "Y",
  "yes",
  "Yes",
  "YES",
  "on",
  "On",
  "ON"
];
var FALSE_VALUES = [
  "false",
  "False",
  "FALSE",
  "n",
  "N",
  "no",
  "No",
  "NO",
  "off",
  "Off",
  "OFF"
];
var boolYaml11Tag = defineScalarTag("tag:yaml.org,2002:bool", {
  implicit: true,
  implicitFirstChars: [
    "y",
    "Y",
    "n",
    "N",
    "t",
    "T",
    "f",
    "F",
    "o",
    "O"
  ],
  resolve: (source) => {
    if (TRUE_VALUES.indexOf(source) !== -1) return true;
    if (FALSE_VALUES.indexOf(source) !== -1) return false;
    return NOT_RESOLVED;
  },
  identify: (object) => Object.prototype.toString.call(object) === "[object Boolean]",
  represent: (object) => object ? "true" : "false"
});
var YAML_INTEGER_IMPLICIT_PATTERN$1 = /* @__PURE__ */ new RegExp("^(?:0o[0-7]+|0x[0-9a-fA-F]+|[-+]?[0-9]+)$");
var YAML_INTEGER_EXPLICIT_PATTERN$1 = /* @__PURE__ */ new RegExp("^(?:[-+]?0b[0-1]+|[-+]?0o[0-7]+|[-+]?0x[0-9a-fA-F]+|[-+]?[0-9]+)$");
function parseYamlInteger$2(source) {
  let value = source;
  let sign = 1;
  if (value[0] === "-" || value[0] === "+") {
    if (value[0] === "-") sign = -1;
    value = value.slice(1);
  }
  if (value.startsWith("0b")) return sign * parseInt(value.slice(2), 2);
  if (value.startsWith("0o")) return sign * parseInt(value.slice(2), 8);
  if (value.startsWith("0x")) return sign * parseInt(value.slice(2), 16);
  return sign * parseInt(value, 10);
}
function resolveYamlInteger$2(source, isExplicit) {
  if (isExplicit) {
    if (!YAML_INTEGER_EXPLICIT_PATTERN$1.test(source)) return NOT_RESOLVED;
  } else if (!YAML_INTEGER_IMPLICIT_PATTERN$1.test(source)) return NOT_RESOLVED;
  const result = parseYamlInteger$2(source);
  return Number.isFinite(result) ? result : NOT_RESOLVED;
}
var intCoreTag = defineScalarTag("tag:yaml.org,2002:int", {
  implicit: true,
  implicitFirstChars: [
    "-",
    "+",
    ..."0123456789"
  ],
  resolve: resolveYamlInteger$2,
  identify: (object) => Number.isInteger(object) && !Object.is(object, -0) && object.toString(10).indexOf("e") < 0,
  represent: (object) => object.toString(10)
});
var YAML_INTEGER_IMPLICIT_PATTERN = /* @__PURE__ */ new RegExp("^-?(?:0|[1-9][0-9]*)$");
var YAML_INTEGER_EXPLICIT_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?0b[0-1]+|[-+]?0o[0-7]+|[-+]?0x[0-9a-fA-F]+|[-+]?[0-9]+)$");
function parseYamlInteger$1(source) {
  let value = source;
  let sign = 1;
  if (value[0] === "-" || value[0] === "+") {
    if (value[0] === "-") sign = -1;
    value = value.slice(1);
  }
  if (value.startsWith("0b")) return sign * parseInt(value.slice(2), 2);
  if (value.startsWith("0o")) return sign * parseInt(value.slice(2), 8);
  if (value.startsWith("0x")) return sign * parseInt(value.slice(2), 16);
  return sign * parseInt(value, 10);
}
function resolveYamlInteger$1(source, isExplicit) {
  if (isExplicit) {
    if (!YAML_INTEGER_EXPLICIT_PATTERN.test(source)) return NOT_RESOLVED;
  } else if (!YAML_INTEGER_IMPLICIT_PATTERN.test(source)) return NOT_RESOLVED;
  const result = parseYamlInteger$1(source);
  return Number.isFinite(result) ? result : NOT_RESOLVED;
}
var intJsonTag = defineScalarTag("tag:yaml.org,2002:int", {
  implicit: true,
  implicitFirstChars: ["-", ..."0123456789"],
  resolve: resolveYamlInteger$1,
  identify: (object) => Number.isInteger(object) && !Object.is(object, -0) && object.toString(10).indexOf("e") < 0,
  represent: (object) => object.toString(10)
});
var YAML_INTEGER_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?0x[0-9a-fA-F_]+|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+|[-+]?(?:0|[1-9][0-9_]*))$");
function parseYamlInteger(source) {
  let value = source.replace(/_/g, "");
  let sign = 1;
  if (value[0] === "-" || value[0] === "+") {
    if (value[0] === "-") sign = -1;
    value = value.slice(1);
  }
  if (value.startsWith("0b")) return sign * parseInt(value.slice(2), 2);
  if (value.startsWith("0x")) return sign * parseInt(value.slice(2), 16);
  if (value.includes(":")) {
    let result = 0;
    for (const part of value.split(":")) result = result * 60 + Number(part);
    return sign * result;
  }
  if (value !== "0" && value[0] === "0") return sign * parseInt(value, 8);
  return sign * parseInt(value, 10);
}
function resolveYamlInteger(source) {
  if (!YAML_INTEGER_PATTERN.test(source)) return NOT_RESOLVED;
  const result = parseYamlInteger(source);
  return Number.isFinite(result) ? result : NOT_RESOLVED;
}
var intYaml11Tag = defineScalarTag("tag:yaml.org,2002:int", {
  implicit: true,
  implicitFirstChars: [
    "-",
    "+",
    ..."0123456789"
  ],
  resolve: resolveYamlInteger,
  identify: (object) => Number.isInteger(object) && !Object.is(object, -0) && object.toString(10).indexOf("e") < 0,
  represent: (object) => object.toString(10)
});
var YAML_FLOAT_PATTERN$1 = /* @__PURE__ */ new RegExp("^(?:[-+]?[0-9]+(?:\\.[0-9]*)?(?:[eE][-+]?[0-9]+)?|[-+]?\\.[0-9]+(?:[eE][-+]?[0-9]+)?|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
var YAML_FLOAT_SPECIAL_PATTERN$1 = /* @__PURE__ */ new RegExp("^(?:[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
function resolveYamlFloat$2(source) {
  if (!YAML_FLOAT_PATTERN$1.test(source)) return NOT_RESOLVED;
  let value = source.toLowerCase();
  const sign = value[0] === "-" ? -1 : 1;
  if ("+-".includes(value[0])) value = value.slice(1);
  if (value === ".inf") return sign === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  if (value === ".nan") return NaN;
  const result = sign * parseFloat(value);
  if (Number.isFinite(result) || YAML_FLOAT_SPECIAL_PATTERN$1.test(source)) return result;
  return NOT_RESOLVED;
}
function representYamlFloat$2(object) {
  if (isNaN(object)) return ".nan";
  if (object === Number.POSITIVE_INFINITY) return ".inf";
  if (object === Number.NEGATIVE_INFINITY) return "-.inf";
  if (Object.is(object, -0)) return "-0.0";
  const result = object.toString(10);
  return /^[-+]?[0-9]+e/.test(result) ? result.replace("e", ".e") : result;
}
var floatCoreTag = defineScalarTag("tag:yaml.org,2002:float", {
  implicit: true,
  implicitFirstChars: [
    "-",
    "+",
    ".",
    ..."0123456789"
  ],
  resolve: resolveYamlFloat$2,
  identify: (object) => typeof object === "number" && (!Number.isInteger(object) || Object.is(object, -0) || object.toString(10).indexOf("e") >= 0),
  represent: representYamlFloat$2
});
var YAML_FLOAT_IMPLICIT_PATTERN = /* @__PURE__ */ new RegExp("^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$");
var YAML_FLOAT_EXPLICIT_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?[0-9]+(?:\\.[0-9]*)?(?:[eE][-+]?[0-9]+)?|[-+]?\\.[0-9]+(?:[eE][-+]?[0-9]+)?|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
function resolveYamlFloat$1(source, isExplicit) {
  if (isExplicit) {
    if (!YAML_FLOAT_EXPLICIT_PATTERN.test(source)) return NOT_RESOLVED;
    let value = source.toLowerCase();
    const sign = value[0] === "-" ? -1 : 1;
    if ("+-".includes(value[0])) value = value.slice(1);
    if (value === ".inf") return sign === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    if (value === ".nan") return NaN;
    const result2 = sign * parseFloat(value);
    return Number.isFinite(result2) ? result2 : NOT_RESOLVED;
  }
  if (!YAML_FLOAT_IMPLICIT_PATTERN.test(source)) return NOT_RESOLVED;
  const result = Number(source);
  if (Number.isFinite(result)) return result;
  return NOT_RESOLVED;
}
function representYamlFloat$1(object) {
  if (isNaN(object)) return ".nan";
  if (object === Number.POSITIVE_INFINITY) return ".inf";
  if (object === Number.NEGATIVE_INFINITY) return "-.inf";
  if (Object.is(object, -0)) return "-0.0";
  const result = object.toString(10);
  return /^[-+]?[0-9]+e/.test(result) ? result.replace("e", ".e") : result;
}
var floatJsonTag = defineScalarTag("tag:yaml.org,2002:float", {
  implicit: true,
  implicitFirstChars: ["-", ..."0123456789"],
  resolve: resolveYamlFloat$1,
  identify: (object) => typeof object === "number" && (!Number.isInteger(object) || Object.is(object, -0) || object.toString(10).indexOf("e") >= 0),
  represent: representYamlFloat$1
});
var YAML_FLOAT_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?(?:(?:[0-9][0-9_]*)?\\.[0-9_]*)(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\\.[0-9_]*|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
var YAML_FLOAT_SPECIAL_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
function resolveYamlFloat(source) {
  if (!YAML_FLOAT_PATTERN.test(source)) return NOT_RESOLVED;
  let value = source.toLowerCase().replace(/_/g, "");
  const sign = value[0] === "-" ? -1 : 1;
  if ("+-".includes(value[0])) value = value.slice(1);
  if (value === ".inf") return sign === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  if (value === ".nan") return NaN;
  let result = 0;
  if (value.includes(":")) {
    for (const part of value.split(":")) result = result * 60 + Number(part);
    result *= sign;
  } else result = sign * parseFloat(value);
  if (Number.isFinite(result) || YAML_FLOAT_SPECIAL_PATTERN.test(source)) return result;
  return NOT_RESOLVED;
}
function representYamlFloat(object) {
  if (isNaN(object)) return ".nan";
  if (object === Number.POSITIVE_INFINITY) return ".inf";
  if (object === Number.NEGATIVE_INFINITY) return "-.inf";
  if (Object.is(object, -0)) return "-0.0";
  const result = object.toString(10);
  return /^[-+]?[0-9]+e/.test(result) ? result.replace("e", ".e") : result;
}
var floatYaml11Tag = defineScalarTag("tag:yaml.org,2002:float", {
  implicit: true,
  implicitFirstChars: [
    "-",
    "+",
    ".",
    ..."0123456789"
  ],
  resolve: resolveYamlFloat,
  identify: (object) => typeof object === "number" && (!Number.isInteger(object) || Object.is(object, -0) || object.toString(10).indexOf("e") >= 0),
  represent: representYamlFloat
});
var mergeTag = defineScalarTag("tag:yaml.org,2002:merge", {
  implicit: true,
  implicitFirstChars: ["<"],
  resolve: (source, isExplicit) => {
    if (source === "<<" || isExplicit && source === "") return MERGE_KEY;
    return NOT_RESOLVED;
  }
});
var BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
function resolveYamlBinary(source) {
  const input = source.replace(/\s/g, "");
  if (input.length % 4 !== 0 || !BASE64_PATTERN.test(input)) return NOT_RESOLVED;
  const binary = atob(input);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) result[index] = binary.charCodeAt(index);
  return result;
}
function representYamlBinary(object) {
  let binary = "";
  for (let index = 0; index < object.length; index++) binary += String.fromCharCode(object[index]);
  return btoa(binary);
}
var binaryTag = defineScalarTag("tag:yaml.org,2002:binary", {
  resolve: resolveYamlBinary,
  identify: (object) => Object.prototype.toString.call(object) === "[object Uint8Array]",
  represent: representYamlBinary
});
var YAML_DATE_REGEXP = /* @__PURE__ */ new RegExp("^([0-9][0-9][0-9][0-9])-([0-9][0-9])-([0-9][0-9])$");
var YAML_TIMESTAMP_REGEXP = /* @__PURE__ */ new RegExp("^([0-9][0-9][0-9][0-9])-([0-9][0-9]?)-([0-9][0-9]?)(?:[Tt]|[ \\t]+)([0-9][0-9]?):([0-9][0-9]):([0-9][0-9])(?:\\.([0-9]*))?(?:[ \\t]*(Z|([-+])([0-9][0-9]?)(?::([0-9][0-9]))?))?$");
function resolveYamlTimestamp(source) {
  let match = YAML_DATE_REGEXP.exec(source);
  if (match === null) match = YAML_TIMESTAMP_REGEXP.exec(source);
  if (match === null) return NOT_RESOLVED;
  const year = +match[1];
  const month = +match[2] - 1;
  const day = +match[3];
  if (!match[4]) {
    const date2 = new Date(Date.UTC(year, month, day));
    if (date2.getUTCFullYear() !== year || date2.getUTCMonth() !== month || date2.getUTCDate() !== day) return NOT_RESOLVED;
    return date2;
  }
  const hour = +match[4];
  const minute = +match[5];
  const second = +match[6];
  let fraction = 0;
  if (hour > 23 || minute > 59 || second > 59) return NOT_RESOLVED;
  if (match[7]) {
    let value = match[7].slice(0, 3);
    while (value.length < 3) value += "0";
    fraction = +value;
  }
  const date = new Date(Date.UTC(year, month, day, hour, minute, second, fraction));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return NOT_RESOLVED;
  if (match[9]) {
    const offsetHour = +match[10];
    const offsetMinute = +(match[11] || 0);
    if (offsetHour > 23 || offsetMinute > 59) return NOT_RESOLVED;
    const offset = (offsetHour * 60 + offsetMinute) * 6e4;
    date.setTime(date.getTime() - (match[9] === "-" ? -offset : offset));
  }
  return date;
}
var timestampTag = defineScalarTag("tag:yaml.org,2002:timestamp", {
  implicit: true,
  implicitFirstChars: [..."0123456789"],
  resolve: resolveYamlTimestamp,
  identify: (object) => object instanceof Date,
  represent: (object) => object.toISOString()
});
var seqTag = defineSequenceTag("tag:yaml.org,2002:seq", {
  create: () => [],
  addItem: (container, item) => {
    container.push(item);
  },
  identify: Array.isArray
});
function isPlainObject(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  const prototype = Object.getPrototypeOf(data);
  return prototype === null || prototype === Object.prototype;
}
function pick(object, keys) {
  const result = {};
  for (const key of keys) if (object[key] !== void 0) result[key] = object[key];
  return result;
}
var omapTag = defineSequenceTag("tag:yaml.org,2002:omap", {
  create: () => ({
    list: [],
    seen: /* @__PURE__ */ new Set()
  }),
  addItem: (carrier, item) => {
    let key;
    if (item instanceof Map) {
      if (item.size !== 1) return "cannot resolve an ordered map item";
      key = item.keys().next().value;
    } else if (isPlainObject(item)) {
      const itemKeys = Object.keys(item);
      if (itemKeys.length !== 1) return "cannot resolve an ordered map item";
      key = itemKeys[0];
    } else return "cannot resolve an ordered map item";
    if (carrier.seen.has(key)) return "duplicate key in ordered map";
    carrier.seen.add(key);
    carrier.list.push(item);
    return "";
  },
  finalize: (carrier) => carrier.list
});
var pairsTag = defineSequenceTag("tag:yaml.org,2002:pairs", {
  create: () => [],
  addItem: (container, item) => {
    if (item instanceof Map) {
      if (item.size !== 1) return "cannot resolve a pairs item";
      container.push(item.entries().next().value);
      return "";
    }
    if (Object.prototype.toString.call(item) !== "[object Object]") return "cannot resolve a pairs item";
    const object = item;
    const keys = Object.keys(object);
    if (keys.length !== 1) return "cannot resolve a pairs item";
    container.push([keys[0], object[keys[0]]]);
    return "";
  }
});
var mapTag = defineMappingTag("tag:yaml.org,2002:map", {
  create: () => ({}),
  identify: isPlainObject,
  represent: (o) => {
    const map = /* @__PURE__ */ new Map();
    for (const key of Object.keys(o)) map.set(key, o[key]);
    return map;
  },
  addPair: (container, key, value) => {
    if (key !== null && typeof key === "object") return "object-based map does not support complex keys";
    const normalizedKey = String(key);
    if (normalizedKey === "__proto__") Object.defineProperty(container, normalizedKey, {
      value,
      enumerable: true,
      configurable: true,
      writable: true
    });
    else container[normalizedKey] = value;
    return "";
  },
  has: (container, key) => {
    if (key !== null && typeof key === "object") return false;
    return Object.prototype.hasOwnProperty.call(container, String(key));
  },
  keys: (container) => Object.keys(container),
  get: (container, key) => container[String(key)]
});
var setTag = defineMappingTag("tag:yaml.org,2002:set", {
  create: () => /* @__PURE__ */ new Set(),
  identify: (data) => data instanceof Set,
  represent: (data) => {
    const map = /* @__PURE__ */ new Map();
    for (const key of data) map.set(key, null);
    return map;
  },
  addPair: (container, key, value) => {
    if (value !== null) return "cannot resolve a set item";
    container.add(key);
    return "";
  },
  has: (container, key) => container.has(key),
  keys: (container) => container.keys(),
  get: () => null
});
function createTagDefinitionMap() {
  return {
    scalar: {},
    sequence: {},
    mapping: {}
  };
}
function createTagDefinitionListMap() {
  return {
    scalar: [],
    sequence: [],
    mapping: []
  };
}
function compileTags(tags) {
  const result = [];
  for (const tag of tags) {
    let index = result.length;
    for (let previousIndex = 0; previousIndex < result.length; previousIndex++) {
      const previous = result[previousIndex];
      if (previous.nodeKind === tag.nodeKind && previous.tagName === tag.tagName && previous.matchByTagPrefix === tag.matchByTagPrefix) {
        index = previousIndex;
        break;
      }
    }
    result[index] = tag;
  }
  return result;
}
var Schema = class Schema2 {
  tags;
  implicitScalarTags;
  implicitScalarByFirstChar;
  implicitScalarAnyFirstChar;
  defaultScalarTag;
  defaultSequenceTag;
  defaultMappingTag;
  exact;
  prefix;
  constructor(tags) {
    const compiledTags = compileTags(tags);
    const implicitScalarTags = [];
    const exact = createTagDefinitionMap();
    const prefix = createTagDefinitionListMap();
    for (const tag of compiledTags) {
      if (tag.nodeKind === "scalar" && tag.implicit) {
        if (tag.matchByTagPrefix) throw new Error("Implicit scalar tags cannot match by tag prefix");
        implicitScalarTags.push(tag);
      }
      switch (tag.nodeKind) {
        case "scalar":
          if (tag.matchByTagPrefix) prefix.scalar.push(tag);
          else exact.scalar[tag.tagName] = tag;
          break;
        case "sequence":
          if (tag.matchByTagPrefix) prefix.sequence.push(tag);
          else exact.sequence[tag.tagName] = tag;
          break;
        case "mapping":
          if (tag.matchByTagPrefix) prefix.mapping.push(tag);
          else exact.mapping[tag.tagName] = tag;
          break;
      }
    }
    const implicitScalarAnyFirstChar = implicitScalarTags.filter((tag) => tag.implicitFirstChars === null);
    const keys = /* @__PURE__ */ new Set();
    for (const tag of implicitScalarTags) if (tag.implicitFirstChars !== null) for (const key of tag.implicitFirstChars) keys.add(key);
    const implicitScalarByFirstChar = /* @__PURE__ */ new Map();
    for (const key of keys) implicitScalarByFirstChar.set(key, implicitScalarTags.filter((tag) => tag.implicitFirstChars === null || tag.implicitFirstChars.indexOf(key) !== -1));
    const defaultScalarTag = exact.scalar["tag:yaml.org,2002:str"];
    if (!defaultScalarTag) throw new Error("schema does not define the default scalar tag (tag:yaml.org,2002:str)");
    this.tags = compiledTags;
    this.implicitScalarTags = implicitScalarTags;
    this.implicitScalarByFirstChar = implicitScalarByFirstChar;
    this.implicitScalarAnyFirstChar = implicitScalarAnyFirstChar;
    this.defaultScalarTag = defaultScalarTag;
    this.defaultSequenceTag = exact.sequence["tag:yaml.org,2002:seq"];
    this.defaultMappingTag = exact.mapping["tag:yaml.org,2002:map"];
    this.exact = exact;
    this.prefix = prefix;
  }
  withTags(...tags) {
    let flatTags = [];
    for (const tag of tags) flatTags = flatTags.concat(tag);
    return new Schema2([...this.tags, ...flatTags]);
  }
};
var FAILSAFE_SCHEMA = new Schema([
  strTag,
  seqTag,
  mapTag
]);
var JSON_SCHEMA = new Schema([
  ...FAILSAFE_SCHEMA.tags,
  nullJsonTag,
  boolJsonTag,
  intJsonTag,
  floatJsonTag
]);
var CORE_SCHEMA = new Schema([
  ...FAILSAFE_SCHEMA.tags,
  nullCoreTag,
  boolCoreTag,
  intCoreTag,
  floatCoreTag
]);
var YAML11_SCHEMA = new Schema([
  ...FAILSAFE_SCHEMA.tags,
  nullYaml11Tag,
  boolYaml11Tag,
  intYaml11Tag,
  floatYaml11Tag,
  timestampTag,
  mergeTag,
  binaryTag,
  omapTag,
  pairsTag,
  setTag
]);
var realMapTag = defineMappingTag("tag:yaml.org,2002:map", {
  create: () => /* @__PURE__ */ new Map(),
  addPair: (container, key, value) => {
    container.set(key, value);
    return "";
  },
  has: (container, key) => container.has(key),
  keys: (container) => container.keys(),
  get: (container, key) => container.get(key),
  identify: (data) => data instanceof Map || isPlainObject(data),
  represent: (data) => {
    if (data instanceof Map) return data;
    const map = /* @__PURE__ */ new Map();
    const obj = data;
    for (const key of Object.keys(obj)) map.set(key, obj[key]);
    return map;
  }
});
function normalizeKey(key) {
  if (Array.isArray(key)) {
    const array = Array.prototype.slice.call(key);
    for (let index = 0; index < array.length; index++) {
      if (Array.isArray(array[index])) return null;
      if (typeof array[index] === "object" && Object.prototype.toString.call(array[index]) === "[object Object]") array[index] = "[object Object]";
    }
    return String(array);
  }
  if (typeof key === "object" && Object.prototype.toString.call(key) === "[object Object]") return "[object Object]";
  return String(key);
}
var legacyMapTag = defineMappingTag("tag:yaml.org,2002:map", {
  create: () => ({}),
  identify: isPlainObject,
  represent: (o) => {
    const map = /* @__PURE__ */ new Map();
    for (const key of Object.keys(o)) map.set(key, o[key]);
    return map;
  },
  addPair: (container, key, value) => {
    const normalizedKey = normalizeKey(key);
    if (normalizedKey === null) return "nested arrays are not supported inside keys";
    if (normalizedKey === "__proto__") Object.defineProperty(container, normalizedKey, {
      value,
      enumerable: true,
      configurable: true,
      writable: true
    });
    else container[normalizedKey] = value;
    return "";
  },
  has: (container, key) => {
    const normalizedKey = normalizeKey(key);
    return normalizedKey !== null && Object.prototype.hasOwnProperty.call(container, normalizedKey);
  },
  keys: (container) => Object.keys(container),
  get: (container, key) => container[String(key)]
});
var DEFAULT_SNIPPET_OPTIONS = {
  maxLength: 79,
  indent: 1,
  linesBefore: 3,
  linesAfter: 2
};
function getLine(buffer, lineStart, lineEnd, position, maxLineLength) {
  let head = "";
  let tail = "";
  const maxHalfLength = Math.floor(maxLineLength / 2) - 1;
  if (position - lineStart > maxHalfLength) {
    head = " ... ";
    lineStart = position - maxHalfLength + head.length;
  }
  if (lineEnd - position > maxHalfLength) {
    tail = " ...";
    lineEnd = position + maxHalfLength - tail.length;
  }
  return {
    str: head + buffer.slice(lineStart, lineEnd).replace(/\t/g, "\u2192") + tail,
    pos: position - lineStart + head.length
  };
}
function padStart(string, max) {
  return " ".repeat(Math.max(max - string.length, 0)) + string;
}
function makeSnippet(mark, options) {
  if (!mark.buffer) return null;
  const opts = {
    ...DEFAULT_SNIPPET_OPTIONS,
    ...options
  };
  const re = /\r?\n|\r|\0/g;
  const lineStarts = [0];
  const lineEnds = [];
  let match;
  let foundLineNo = -1;
  while (match = re.exec(mark.buffer)) {
    lineEnds.push(match.index);
    lineStarts.push(match.index + match[0].length);
    if (mark.position <= match.index && foundLineNo < 0) foundLineNo = lineStarts.length - 2;
  }
  if (foundLineNo < 0) foundLineNo = lineStarts.length - 1;
  let result = "";
  const lineNoLength = Math.min(mark.line + opts.linesAfter, lineEnds.length).toString().length;
  const maxLineLength = opts.maxLength - (opts.indent + lineNoLength + 3);
  for (let i = 1; i <= opts.linesBefore; i++) {
    if (foundLineNo - i < 0) break;
    const line2 = getLine(mark.buffer, lineStarts[foundLineNo - i], lineEnds[foundLineNo - i], mark.position - (lineStarts[foundLineNo] - lineStarts[foundLineNo - i]), maxLineLength);
    result = `${" ".repeat(opts.indent)}${padStart((mark.line - i + 1).toString(), lineNoLength)} | ${line2.str}
${result}`;
  }
  const line = getLine(mark.buffer, lineStarts[foundLineNo], lineEnds[foundLineNo], mark.position, maxLineLength);
  result += `${" ".repeat(opts.indent)}${padStart((mark.line + 1).toString(), lineNoLength)} | ${line.str}
`;
  result += `${"-".repeat(opts.indent + lineNoLength + 3 + line.pos)}^
`;
  for (let i = 1; i <= opts.linesAfter; i++) {
    if (foundLineNo + i >= lineEnds.length) break;
    const line2 = getLine(mark.buffer, lineStarts[foundLineNo + i], lineEnds[foundLineNo + i], mark.position - (lineStarts[foundLineNo] - lineStarts[foundLineNo + i]), maxLineLength);
    result += `${" ".repeat(opts.indent)}${padStart((mark.line + i + 1).toString(), lineNoLength)} | ${line2.str}
`;
  }
  return result.replace(/\n$/, "");
}
function formatError(exception, compact) {
  let where = "";
  if (!exception.mark) return exception.reason;
  if (exception.mark.name) where += `in "${exception.mark.name}" `;
  where += `(${exception.mark.line + 1}:${exception.mark.column + 1})`;
  if (!compact && exception.mark.snippet) where += `

${exception.mark.snippet}`;
  return `${exception.reason} ${where}`;
}
var YAMLException = class extends Error {
  reason;
  mark;
  constructor(reason, mark) {
    super();
    this.name = "YAMLException";
    this.reason = reason;
    this.mark = mark;
    this.message = formatError(this, false);
    if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor);
  }
  toString(compact) {
    return `${this.name}: ${formatError(this, compact)}`;
  }
};
function throwErrorAt(source, position, message, filename = "") {
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < position; index++) {
    const ch = source.charCodeAt(index);
    if (ch === 10) {
      line++;
      lineStart = index + 1;
    } else if (ch === 13) {
      line++;
      if (source.charCodeAt(index + 1) === 10) index++;
      lineStart = index + 1;
    }
  }
  const mark = {
    name: filename,
    buffer: source,
    position,
    line,
    column: position - lineStart
  };
  mark.snippet = makeSnippet(mark);
  throw new YAMLException(message, mark);
}
var NO_RANGE$3 = -1;
function simpleEscapeSequence(c) {
  switch (c) {
    case 48:
      return "\0";
    case 97:
      return "\x07";
    case 98:
      return "\b";
    case 116:
      return "	";
    case 9:
      return "	";
    case 110:
      return "\n";
    case 118:
      return "\v";
    case 102:
      return "\f";
    case 114:
      return "\r";
    case 101:
      return "\x1B";
    case 32:
      return " ";
    case 34:
      return '"';
    case 47:
      return "/";
    case 92:
      return "\\";
    case 78:
      return "\x85";
    case 95:
      return "\xA0";
    case 76:
      return "\u2028";
    case 80:
      return "\u2029";
    default:
      return "";
  }
}
var simpleEscapeCheck = new Array(256);
var simpleEscapeMap = new Array(256);
for (let i = 0; i < 256; i++) {
  simpleEscapeCheck[i] = simpleEscapeSequence(i) ? 1 : 0;
  simpleEscapeMap[i] = simpleEscapeSequence(i);
}
function charFromCodepoint(c) {
  if (c <= 65535) return String.fromCharCode(c);
  return String.fromCharCode((c - 65536 >> 10) + 55296, (c - 65536 & 1023) + 56320);
}
function fromHexCode$1(c) {
  if (c >= 48 && c <= 57) return c - 48;
  return (c | 32) - 97 + 10;
}
function escapedHexLen$1(c) {
  if (c === 120) return 2;
  if (c === 117) return 4;
  return 8;
}
function skipFoldedBreaks(input, position, end) {
  let breaks = 0;
  while (position < end) {
    const ch = input.charCodeAt(position);
    if (ch === 10) {
      breaks++;
      position++;
    } else if (ch === 13) {
      breaks++;
      position++;
      if (input.charCodeAt(position) === 10) position++;
    } else if (ch === 32 || ch === 9) position++;
    else break;
  }
  return {
    position,
    breaks
  };
}
function foldedBreaks(count) {
  if (count === 1) return " ";
  return "\n".repeat(count - 1);
}
function getPlainValue(input, start, end) {
  let result = "";
  let position = start;
  let captureStart = start;
  let captureEnd = start;
  while (position < end) {
    const ch = input.charCodeAt(position);
    if (ch === 10 || ch === 13) {
      result += input.slice(captureStart, captureEnd);
      const fold = skipFoldedBreaks(input, position, end);
      result += foldedBreaks(fold.breaks);
      position = captureStart = captureEnd = fold.position;
    } else {
      position++;
      if (ch !== 32 && ch !== 9) captureEnd = position;
    }
  }
  return result + input.slice(captureStart, captureEnd);
}
function getSingleQuotedValue(input, start, end) {
  let result = "";
  let position = start;
  let captureStart = start;
  let captureEnd = start;
  while (position < end) {
    const ch = input.charCodeAt(position);
    if (ch === 39) {
      result += input.slice(captureStart, position) + "'";
      position += 2;
      captureStart = captureEnd = position;
    } else if (ch === 10 || ch === 13) {
      result += input.slice(captureStart, captureEnd);
      const fold = skipFoldedBreaks(input, position, end);
      result += foldedBreaks(fold.breaks);
      position = captureStart = captureEnd = fold.position;
    } else {
      position++;
      if (ch !== 32 && ch !== 9) captureEnd = position;
    }
  }
  return result + input.slice(captureStart, end);
}
function getDoubleQuotedValue(input, start, end) {
  let result = "";
  let position = start;
  let captureStart = start;
  let captureEnd = start;
  while (position < end) {
    const ch = input.charCodeAt(position);
    if (ch === 92) {
      result += input.slice(captureStart, position);
      position++;
      const escaped = input.charCodeAt(position);
      if (escaped === 10 || escaped === 13) position = skipFoldedBreaks(input, position, end).position;
      else if (escaped < 256 && simpleEscapeCheck[escaped]) {
        result += simpleEscapeMap[escaped];
        position++;
      } else {
        let hexLength = escapedHexLen$1(escaped);
        let hexResult = 0;
        for (; hexLength > 0; hexLength--) {
          position++;
          const digit = fromHexCode$1(input.charCodeAt(position));
          hexResult = (hexResult << 4) + digit;
        }
        result += charFromCodepoint(hexResult);
        position++;
      }
      captureStart = captureEnd = position;
    } else if (ch === 10 || ch === 13) {
      result += input.slice(captureStart, captureEnd);
      const fold = skipFoldedBreaks(input, position, end);
      result += foldedBreaks(fold.breaks);
      position = captureStart = captureEnd = fold.position;
    } else {
      position++;
      if (ch !== 32 && ch !== 9) captureEnd = position;
    }
  }
  return result + input.slice(captureStart, end);
}
function getBlockValue(input, start, end, indent, chomping, folded) {
  const textIndent = indent < 0 ? 0 : indent;
  const region = input.slice(start, end).replace(/\r\n?/g, "\n");
  const lines = region === "" ? [] : (region.endsWith("\n") ? region.slice(0, -1) : region).split("\n");
  let result = "";
  let didReadContent = false;
  let emptyLines = 0;
  let atMoreIndented = false;
  for (const line of lines) {
    let column = 0;
    while (column < textIndent && line.charCodeAt(column) === 32) column++;
    if (indent < 0 || column >= line.length) {
      emptyLines++;
      continue;
    }
    const content = line.slice(textIndent);
    const first = content.charCodeAt(0);
    if (folded) if (first === 32 || first === 9) {
      atMoreIndented = true;
      result += "\n".repeat(didReadContent ? 1 + emptyLines : emptyLines);
    } else if (atMoreIndented) {
      atMoreIndented = false;
      result += "\n".repeat(emptyLines + 1);
    } else if (emptyLines === 0) {
      if (didReadContent) result += " ";
    } else result += "\n".repeat(emptyLines);
    else result += "\n".repeat(didReadContent ? 1 + emptyLines : emptyLines);
    result += content;
    didReadContent = true;
    emptyLines = 0;
  }
  if (chomping === 3) result += "\n".repeat(didReadContent ? 1 + emptyLines : emptyLines);
  else if (chomping !== 2) {
    if (didReadContent) result += "\n";
  }
  return result;
}
function getScalarValue(input, scalar) {
  if (scalar.valueStart === NO_RANGE$3) return "";
  const { valueStart, valueEnd } = scalar;
  if (scalar.fast) return input.slice(valueStart, valueEnd);
  switch (scalar.style) {
    case 2:
      return getSingleQuotedValue(input, valueStart, valueEnd);
    case 3:
      return getDoubleQuotedValue(input, valueStart, valueEnd);
    case 4:
      return getBlockValue(input, valueStart, valueEnd, scalar.indent, scalar.chomping, false);
    case 5:
      return getBlockValue(input, valueStart, valueEnd, scalar.indent, scalar.chomping, true);
    default:
      return getPlainValue(input, valueStart, valueEnd);
  }
}
var DEFAULT_TAG_HANDLERS = {
  "!": "!",
  "!!": "tag:yaml.org,2002:"
};
function tagNameFull(rawTag, tagHandlers) {
  if (rawTag.startsWith("!<") && rawTag.endsWith(">")) return decodeURIComponent(rawTag.slice(2, -1));
  const handleEnd = rawTag.indexOf("!", 1);
  const handle = handleEnd === -1 ? "!" : rawTag.slice(0, handleEnd + 1);
  const prefix = tagHandlers?.[handle] ?? DEFAULT_TAG_HANDLERS[handle] ?? handle;
  return decodeURIComponent(prefix) + decodeURIComponent(rawTag.slice(handle.length));
}
var NO_RANGE$2 = -1;
var DEFAULT_CONSTRUCTOR_OPTIONS = {
  filename: "",
  schema: CORE_SCHEMA,
  json: false,
  maxTotalMergeKeys: 1e4,
  maxAliases: -1
};
function eventPosition$1(event) {
  if ("tagStart" in event && event.tagStart !== NO_RANGE$2) return event.tagStart;
  if ("anchorStart" in event && event.anchorStart !== NO_RANGE$2) return event.anchorStart;
  if ("valueStart" in event && event.valueStart !== NO_RANGE$2) return event.valueStart;
  if ("start" in event) return event.start;
  return 0;
}
function throwError$1(state, message) {
  throwErrorAt(state.source, state.position, message, state.filename);
}
function finalizeCollection(state, position, tag, carrier) {
  try {
    return tag.finalize(carrier);
  } catch (error) {
    if (error instanceof YAMLException) throw error;
    throwErrorAt(state.source, position, error instanceof Error ? error.message : String(error), state.filename);
  }
}
function lookupTag(exact, prefix, tagName) {
  const exactTag = exact[tagName];
  if (exactTag) return exactTag;
  for (const tag of prefix) if (tagName.startsWith(tag.tagName)) return tag;
}
function findExplicitTag(state, exact, prefix, tagName, nodeKind) {
  const tag = lookupTag(exact, prefix, tagName);
  if (tag) return tag;
  throwError$1(state, `unknown ${nodeKind} tag !<${tagName}>`);
}
function constructScalar(state, event) {
  const source = getScalarValue(state.source, event);
  const rawTag = event.tagStart === NO_RANGE$2 ? "" : state.source.slice(event.tagStart, event.tagEnd);
  const strTag2 = state.schema.defaultScalarTag;
  if (rawTag !== "") {
    if (rawTag === "!") return {
      value: source,
      tag: strTag2
    };
    const tagName = tagNameFull(rawTag, state.tagHandlers);
    const scalarTag = lookupTag(state.schema.exact.scalar, state.schema.prefix.scalar, tagName);
    if (scalarTag) {
      const result = scalarTag.resolve(source, true, tagName);
      if (result === NOT_RESOLVED) throwError$1(state, `cannot resolve a node with !<${tagName}> explicit tag`);
      return {
        value: result,
        tag: scalarTag
      };
    }
    const collectionTagDef = lookupTag(state.schema.exact.mapping, state.schema.prefix.mapping, tagName) ?? lookupTag(state.schema.exact.sequence, state.schema.prefix.sequence, tagName);
    if (collectionTagDef) {
      if (source !== "") throwError$1(state, `cannot resolve a node with !<${tagName}> explicit tag`);
      const carrier = collectionTagDef.create(tagName);
      return {
        value: collectionTagDef.carrierIsResult ? carrier : finalizeCollection(state, state.position, collectionTagDef, carrier),
        tag: collectionTagDef
      };
    }
    throwError$1(state, `unknown scalar tag !<${tagName}>`);
  }
  if (event.style === 1) {
    const candidates = state.schema.implicitScalarByFirstChar.get(source.charAt(0)) ?? state.schema.implicitScalarAnyFirstChar;
    for (const tag of candidates) {
      const result = tag.resolve(source, false, tag.tagName);
      if (result !== NOT_RESOLVED) return {
        value: result,
        tag
      };
    }
  }
  return {
    value: strTag2.resolve(source, false, strTag2.tagName),
    tag: strTag2
  };
}
function collectionTag(state, event, exact, prefix, defaultTagName, nodeKind) {
  const rawTag = event.tagStart === NO_RANGE$2 ? "" : state.source.slice(event.tagStart, event.tagEnd);
  const tagName = rawTag === "" || rawTag === "!" ? defaultTagName : tagNameFull(rawTag, state.tagHandlers);
  return {
    tagName,
    tag: findExplicitTag(state, exact, prefix, tagName, nodeKind)
  };
}
function isMappingTag(tag) {
  return tag.nodeKind === "mapping";
}
function mergeKeys(state, frame, source, sourceTag) {
  for (const sourceKey of sourceTag.keys(source)) {
    if (state.maxTotalMergeKeys !== -1 && ++state.totalMergeKeys > state.maxTotalMergeKeys) throwError$1(state, `merge keys exceeded maxTotalMergeKeys (${state.maxTotalMergeKeys})`);
    if (frame.tag.has(frame.value, sourceKey)) continue;
    const err = frame.tag.addPair(frame.value, sourceKey, sourceTag.get(source, sourceKey));
    if (err) throwError$1(state, err);
    (frame.overridable ??= /* @__PURE__ */ new Set()).add(sourceKey);
  }
}
function mergeSource(state, frame, source, sourceTag) {
  state.position = frame.keyPosition;
  if (isMappingTag(sourceTag)) mergeKeys(state, frame, source, sourceTag);
  else if (sourceTag.nodeKind === "sequence" && Array.isArray(source)) for (const element of source) mergeKeys(state, frame, element, frame.tag);
  else throwError$1(state, "cannot merge mappings; the provided source object is unacceptable");
}
function addMappingValue(state, frame, key, value, tag) {
  state.position = frame.keyPosition;
  if (key === MERGE_KEY) {
    mergeSource(state, frame, value, tag);
    return;
  }
  if (!state.json && frame.tag.has(frame.value, key) && !frame.overridable?.has(key)) throwError$1(state, "duplicated mapping key");
  const err = frame.tag.addPair(frame.value, key, value);
  if (err) throwError$1(state, err);
  frame.overridable?.delete(key);
}
function addValue(state, value, tag) {
  const frame = state.frames[state.frames.length - 1];
  if (frame.kind === "document") {
    frame.value = value;
    frame.hasValue = true;
  } else if (frame.kind === "sequence") {
    if (frame.merge) {
      if (!isMappingTag(tag)) throwError$1(state, "cannot merge mappings; the provided source object is unacceptable");
    }
    const err = frame.tag.addItem(frame.value, value, frame.index++);
    if (err) throwError$1(state, err);
  } else if (frame.hasKey) {
    const key = frame.key;
    frame.key = void 0;
    frame.hasKey = false;
    addMappingValue(state, frame, key, value, tag);
  } else {
    frame.key = value;
    frame.keyPosition = state.position;
    frame.hasKey = true;
  }
}
function storeAnchor(state, event, value, tag, isValueFinal) {
  if (event.anchorStart !== NO_RANGE$2) {
    const anchor = {
      value,
      tag,
      isValueFinal
    };
    state.anchors.set(state.source.slice(event.anchorStart, event.anchorEnd), anchor);
    return anchor;
  }
  return null;
}
function constructFromEvents(events, options) {
  const state = {
    ...DEFAULT_CONSTRUCTOR_OPTIONS,
    ...options,
    events,
    documents: [],
    eventIndex: 0,
    position: 0,
    frames: [],
    anchors: /* @__PURE__ */ new Map(),
    tagHandlers: /* @__PURE__ */ Object.create(null),
    totalMergeKeys: 0,
    aliasCount: 0
  };
  while (state.eventIndex < state.events.length) {
    const event = state.events[state.eventIndex++];
    state.position = eventPosition$1(event);
    switch (event.type) {
      case 1:
        state.anchors = /* @__PURE__ */ new Map();
        state.aliasCount = 0;
        state.tagHandlers = /* @__PURE__ */ Object.create(null);
        for (const directive of event.directives) if (directive.kind === "tag") state.tagHandlers[directive.handle] = directive.prefix;
        state.frames.push({
          kind: "document",
          position: state.position,
          value: void 0,
          hasValue: false
        });
        break;
      case 4: {
        const { value, tag } = constructScalar(state, event);
        storeAnchor(state, event, value, tag, true);
        addValue(state, value, tag);
        break;
      }
      case 2: {
        const definition = collectionTag(state, event, state.schema.exact.sequence, state.schema.prefix.sequence, "tag:yaml.org,2002:seq", "sequence");
        const value = definition.tag.create(definition.tagName);
        const anchor = storeAnchor(state, event, value, definition.tag, definition.tag.carrierIsResult);
        const parent = state.frames[state.frames.length - 1];
        const merge = parent !== void 0 && parent.kind === "mapping" && parent.hasKey && parent.key === MERGE_KEY;
        state.frames.push({
          kind: "sequence",
          position: state.position,
          value,
          tag: definition.tag,
          anchor,
          index: 0,
          merge
        });
        break;
      }
      case 3: {
        const definition = collectionTag(state, event, state.schema.exact.mapping, state.schema.prefix.mapping, "tag:yaml.org,2002:map", "mapping");
        const value = definition.tag.create(definition.tagName);
        const anchor = storeAnchor(state, event, value, definition.tag, definition.tag.carrierIsResult);
        state.frames.push({
          kind: "mapping",
          position: state.position,
          value,
          tag: definition.tag,
          anchor,
          key: void 0,
          keyPosition: state.position,
          hasKey: false,
          overridable: null
        });
        break;
      }
      case 5: {
        if (state.maxAliases !== -1 && ++state.aliasCount > state.maxAliases) throwError$1(state, `aliases exceeded maxAliases (${state.maxAliases})`);
        const name = state.source.slice(event.anchorStart, event.anchorEnd);
        const anchor = state.anchors.get(name);
        if (!anchor) throwError$1(state, `unidentified alias "${name}"`);
        if (!anchor.isValueFinal) throwError$1(state, `recursive alias "${name}" is not supported for tag ${anchor.tag.tagName} because it uses finalize()`);
        addValue(state, anchor.value, anchor.tag);
        break;
      }
      case 6: {
        const frame = state.frames.pop();
        if (frame.kind === "document") state.documents.push(frame.value);
        else {
          const value = frame.tag.carrierIsResult ? frame.value : finalizeCollection(state, frame.position, frame.tag, frame.value);
          if (frame.anchor) {
            frame.anchor.value = value;
            frame.anchor.isValueFinal = true;
          }
          addValue(state, value, frame.tag);
        }
        break;
      }
    }
  }
  return state.documents;
}
var NO_RANGE$1 = -1;
var HAS_OWN = Object.prototype.hasOwnProperty;
var CONTEXT_FLOW_IN = 1;
var CONTEXT_FLOW_OUT = 2;
var CONTEXT_BLOCK_IN = 3;
var CONTEXT_BLOCK_OUT = 4;
var PATTERN_NON_PRINTABLE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x84\x86-\x9F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;
var PATTERN_FLOW_INDICATORS = /[,\[\]{}]/;
var PATTERN_TAG_HANDLE = /^(?:!|!!|![0-9A-Za-z-]+!)$/;
var NS_URI_CHAR = String.raw`(?:%[0-9A-Fa-f]{2}|[0-9A-Za-z\-#;/?:@&=+$,_.!~*'()\[\]])`;
var NS_TAG_CHAR = String.raw`(?:%[0-9A-Fa-f]{2}|[0-9A-Za-z\-#;/?:@&=+$.~*'()_])`;
var PATTERN_TAG_URI = new RegExp(`^(?:${NS_URI_CHAR})*$`);
var PATTERN_TAG_SUFFIX = new RegExp(`^(?:${NS_TAG_CHAR})+$`);
var PATTERN_TAG_PREFIX = new RegExp(`^(?:!(?:${NS_URI_CHAR})*|${NS_TAG_CHAR}(?:${NS_URI_CHAR})*)$`);
var DEFAULT_PARSER_OPTIONS = {
  filename: "",
  maxDepth: 100
};
function addDocumentEvent(state, explicitStart, explicitEnd) {
  state.events.push({
    type: 1,
    explicitStart,
    explicitEnd,
    directives: state.directives
  });
}
function addSequenceEvent(state, start, anchorStart, anchorEnd, tagStart, tagEnd, style) {
  state.events.push({
    type: 2,
    start,
    anchorStart,
    anchorEnd,
    tagStart,
    tagEnd,
    style
  });
}
function addMappingEvent(state, start, anchorStart, anchorEnd, tagStart, tagEnd, style) {
  state.events.push({
    type: 3,
    start,
    anchorStart,
    anchorEnd,
    tagStart,
    tagEnd,
    style
  });
}
function insertFlowPairMappingEvent(state, snapshot) {
  state.events.splice(snapshot.eventsLength, 0, {
    type: 3,
    start: snapshot.position,
    anchorStart: NO_RANGE$1,
    anchorEnd: NO_RANGE$1,
    tagStart: NO_RANGE$1,
    tagEnd: NO_RANGE$1,
    style: 2
  });
}
function addScalarEvent(state, valueStart, valueEnd, anchorStart, anchorEnd, tagStart, tagEnd, style, chomping = 1, indent = -1, fast = false) {
  state.events.push({
    type: 4,
    valueStart,
    valueEnd,
    anchorStart,
    anchorEnd,
    tagStart,
    tagEnd,
    style,
    chomping,
    indent,
    fast
  });
}
function addAliasEvent(state, anchorStart, anchorEnd) {
  state.events.push({
    type: 5,
    anchorStart,
    anchorEnd
  });
}
function addPopEvent(state) {
  state.events.push({ type: 6 });
}
function addEmptyScalarEvent(state) {
  addScalarEvent(state, NO_RANGE$1, NO_RANGE$1, NO_RANGE$1, NO_RANGE$1, NO_RANGE$1, NO_RANGE$1, 1);
}
function emptyProperties() {
  return {
    anchorStart: NO_RANGE$1,
    anchorEnd: NO_RANGE$1,
    tagStart: NO_RANGE$1,
    tagEnd: NO_RANGE$1
  };
}
function snapshotState(state) {
  return {
    position: state.position,
    line: state.line,
    lineStart: state.lineStart,
    lineIndent: state.lineIndent,
    firstTabInLine: state.firstTabInLine,
    eventsLength: state.events.length
  };
}
function restoreState(state, snapshot) {
  state.position = snapshot.position;
  state.line = snapshot.line;
  state.lineStart = snapshot.lineStart;
  state.lineIndent = snapshot.lineIndent;
  state.firstTabInLine = snapshot.firstTabInLine;
  state.events.length = snapshot.eventsLength;
}
function throwError(state, message) {
  throwErrorAt(state.input.slice(0, state.length), state.position, message, state.filename);
}
function isEol(c) {
  return c === 10 || c === 13;
}
function isWhiteSpace(c) {
  return c === 9 || c === 32;
}
function isWsOrEol(c) {
  return isWhiteSpace(c) || isEol(c);
}
function isWsOrEolOrEnd(c) {
  return c === 0 || isWsOrEol(c);
}
function isFlowIndicator(c) {
  return c === 44 || c === 91 || c === 93 || c === 123 || c === 125;
}
function fromDecimalCode(c) {
  return c >= 48 && c <= 57 ? c - 48 : -1;
}
function fromHexCode(c) {
  if (c >= 48 && c <= 57) return c - 48;
  const lc = c | 32;
  if (lc >= 97 && lc <= 102) return lc - 97 + 10;
  return -1;
}
function escapedHexLen(c) {
  if (c === 120) return 2;
  if (c === 117) return 4;
  if (c === 85) return 8;
  return 0;
}
function isSimpleEscape(c) {
  return c === 48 || c === 97 || c === 98 || c === 116 || c === 9 || c === 110 || c === 118 || c === 102 || c === 114 || c === 101 || c === 32 || c === 34 || c === 47 || c === 92 || c === 78 || c === 95 || c === 76 || c === 80;
}
function consumeLineBreak(state) {
  if (state.input.charCodeAt(state.position) === 10) state.position++;
  else {
    state.position++;
    if (state.input.charCodeAt(state.position) === 10) state.position++;
  }
  state.line++;
  state.lineStart = state.position;
  state.lineIndent = 0;
  state.firstTabInLine = -1;
}
function skipSeparationSpace(state, allowComments) {
  let lineBreaks = 0;
  let ch = state.input.charCodeAt(state.position);
  let hasSeparation = state.position === state.lineStart || isWsOrEol(state.input.charCodeAt(state.position - 1));
  while (ch !== 0) {
    while (isWhiteSpace(ch)) {
      hasSeparation = true;
      if (ch === 9 && state.firstTabInLine === -1) state.firstTabInLine = state.position;
      ch = state.input.charCodeAt(++state.position);
    }
    if (allowComments && hasSeparation && ch === 35) do
      ch = state.input.charCodeAt(++state.position);
    while (!isEol(ch) && ch !== 0);
    if (!isEol(ch)) break;
    consumeLineBreak(state);
    lineBreaks++;
    hasSeparation = true;
    ch = state.input.charCodeAt(state.position);
    while (ch === 32) {
      state.lineIndent++;
      ch = state.input.charCodeAt(++state.position);
    }
  }
  return lineBreaks;
}
function testDocumentSeparator(state, position = state.position) {
  const ch = state.input.charCodeAt(position);
  if ((ch === 45 || ch === 46) && ch === state.input.charCodeAt(position + 1) && ch === state.input.charCodeAt(position + 2)) {
    const following = state.input.charCodeAt(position + 3);
    return following === 0 || isWsOrEol(following);
  }
  return false;
}
function skipUntilLineEnd(state) {
  let ch = state.input.charCodeAt(state.position);
  while (ch !== 0 && !isEol(ch)) ch = state.input.charCodeAt(++state.position);
}
function checkPrintable(state, start, end) {
  if (PATTERN_NON_PRINTABLE.test(state.input.slice(start, end))) throwError(state, "the stream contains non-printable characters");
}
function readTagProperty(state, props, inFlow) {
  if (state.input.charCodeAt(state.position) !== 33) return false;
  if (props.tagStart !== NO_RANGE$1) throwError(state, "duplication of a tag property");
  const start = state.position;
  let isVerbatim = false;
  let isNamed = false;
  let tagHandle = "!";
  let ch = state.input.charCodeAt(++state.position);
  if (ch === 60) {
    isVerbatim = true;
    ch = state.input.charCodeAt(++state.position);
  } else if (ch === 33) {
    isNamed = true;
    tagHandle = "!!";
    ch = state.input.charCodeAt(++state.position);
  }
  let suffixStart = state.position;
  let tagName;
  if (isVerbatim) {
    while (ch !== 0 && ch !== 62) ch = state.input.charCodeAt(++state.position);
    if (ch !== 62) throwError(state, "unexpected end of the stream within a verbatim tag");
    tagName = state.input.slice(suffixStart, state.position);
    state.position++;
  } else {
    while (ch !== 0 && !isWsOrEol(ch) && !(inFlow && isFlowIndicator(ch))) {
      if (ch === 33) if (!isNamed) {
        tagHandle = state.input.slice(suffixStart - 1, state.position + 1);
        if (!PATTERN_TAG_HANDLE.test(tagHandle)) throwError(state, "named tag handle cannot contain such characters");
        isNamed = true;
        suffixStart = state.position + 1;
      } else throwError(state, "tag suffix cannot contain exclamation marks");
      ch = state.input.charCodeAt(++state.position);
    }
    tagName = state.input.slice(suffixStart, state.position);
    if (PATTERN_FLOW_INDICATORS.test(tagName)) throwError(state, "tag suffix cannot contain flow indicator characters");
  }
  if (tagName && !(isVerbatim ? PATTERN_TAG_URI.test(tagName) : PATTERN_TAG_SUFFIX.test(tagName))) throwError(state, `tag name cannot contain such characters: ${tagName}`);
  if (!isVerbatim && tagHandle !== "!" && tagHandle !== "!!" && !HAS_OWN.call(state.tagHandlers, tagHandle)) throwError(state, `undeclared tag handle "${tagHandle}"`);
  props.tagStart = start;
  props.tagEnd = state.position;
  return true;
}
function readAnchorProperty(state, props) {
  if (state.input.charCodeAt(state.position) !== 38) return false;
  if (props.anchorStart !== NO_RANGE$1) throwError(state, "duplication of an anchor property");
  state.position++;
  const start = state.position;
  while (state.input.charCodeAt(state.position) !== 0 && !isWsOrEol(state.input.charCodeAt(state.position)) && !isFlowIndicator(state.input.charCodeAt(state.position))) state.position++;
  if (state.position === start) throwError(state, "name of an anchor node must contain at least one character");
  props.anchorStart = start;
  props.anchorEnd = state.position;
  return true;
}
function readAlias(state, props) {
  if (state.input.charCodeAt(state.position) !== 42) return false;
  if (props.anchorStart !== NO_RANGE$1 || props.tagStart !== NO_RANGE$1) throwError(state, "alias node should not have any properties");
  state.position++;
  const start = state.position;
  while (state.input.charCodeAt(state.position) !== 0 && !isWsOrEol(state.input.charCodeAt(state.position)) && !isFlowIndicator(state.input.charCodeAt(state.position))) state.position++;
  if (state.position === start) throwError(state, "name of an alias node must contain at least one character");
  addAliasEvent(state, start, state.position);
  return true;
}
function readFlowScalarBreak(state, nodeIndent) {
  skipSeparationSpace(state, false);
  if (state.lineIndent < nodeIndent) throwError(state, "deficient indentation");
}
function readSingleQuotedScalar(state, nodeIndent, props) {
  if (state.input.charCodeAt(state.position) !== 39) return false;
  state.position++;
  const start = state.position;
  let simple = true;
  while (state.input.charCodeAt(state.position) !== 0) {
    const ch = state.input.charCodeAt(state.position);
    if (ch === 39) {
      if (state.input.charCodeAt(state.position + 1) === 39) {
        simple = false;
        state.position += 2;
        continue;
      }
      const end = state.position;
      state.position++;
      addScalarEvent(state, start, end, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, 2, 1, -1, simple);
      return true;
    }
    if (isEol(ch)) {
      simple = false;
      readFlowScalarBreak(state, nodeIndent);
    } else if (state.position === state.lineStart && testDocumentSeparator(state)) throwError(state, "unexpected end of the document within a single quoted scalar");
    else if (ch !== 9 && ch < 32) throwError(state, "expected valid JSON character");
    else state.position++;
  }
  throwError(state, "unexpected end of the stream within a single quoted scalar");
}
function readDoubleQuotedScalar(state, nodeIndent, props) {
  if (state.input.charCodeAt(state.position) !== 34) return false;
  state.position++;
  const start = state.position;
  let simple = true;
  while (state.input.charCodeAt(state.position) !== 0) {
    const ch = state.input.charCodeAt(state.position);
    if (ch === 34) {
      const end = state.position;
      state.position++;
      addScalarEvent(state, start, end, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, 3, 1, -1, simple);
      return true;
    }
    if (ch === 92) {
      simple = false;
      const escaped = state.input.charCodeAt(++state.position);
      if (isEol(escaped)) readFlowScalarBreak(state, nodeIndent);
      else if (isSimpleEscape(escaped)) state.position++;
      else {
        let hexLength = escapedHexLen(escaped);
        if (hexLength === 0) throwError(state, "unknown escape sequence");
        while (hexLength-- > 0) {
          state.position++;
          if (fromHexCode(state.input.charCodeAt(state.position)) < 0) throwError(state, "expected hexadecimal character");
        }
        state.position++;
      }
    } else if (isEol(ch)) {
      simple = false;
      readFlowScalarBreak(state, nodeIndent);
    } else if (state.position === state.lineStart && testDocumentSeparator(state)) throwError(state, "unexpected end of the document within a double quoted scalar");
    else if (ch !== 9 && ch < 32) throwError(state, "expected valid JSON character");
    else state.position++;
  }
  throwError(state, "unexpected end of the stream within a double quoted scalar");
}
function readBlockScalar(state, parentIndent, props) {
  const ch = state.input.charCodeAt(state.position);
  let chomping = 1;
  let indent = -1;
  let detectedIndent = false;
  if (ch !== 124 && ch !== 62) return false;
  const style = ch === 124 ? 4 : 5;
  state.position++;
  while (state.input.charCodeAt(state.position) !== 0) {
    const current = state.input.charCodeAt(state.position);
    const digit = fromDecimalCode(current);
    if (current === 43 || current === 45) {
      if (chomping !== 1) throwError(state, "repeat of a chomping mode identifier");
      chomping = current === 43 ? 3 : 2;
      state.position++;
    } else if (digit >= 0) {
      if (digit === 0) throwError(state, "bad explicit indentation width of a block scalar; it cannot be less than one");
      if (detectedIndent) throwError(state, "repeat of an indentation width identifier");
      indent = parentIndent + digit - 1;
      detectedIndent = true;
      state.position++;
    } else break;
  }
  let hadWhitespace = false;
  while (isWhiteSpace(state.input.charCodeAt(state.position))) {
    hadWhitespace = true;
    state.position++;
  }
  if (hadWhitespace && state.input.charCodeAt(state.position) === 35) skipUntilLineEnd(state);
  if (isEol(state.input.charCodeAt(state.position))) consumeLineBreak(state);
  else if (state.input.charCodeAt(state.position) !== 0) throwError(state, "a line break is expected");
  let contentIndent = detectedIndent ? indent : -1;
  let maxLeadingIndent = 0;
  const valueStart = state.position;
  let valueEnd = state.position;
  while (state.input.charCodeAt(state.position) !== 0) {
    const linePosition = state.position;
    let column = 0;
    while (state.input.charCodeAt(linePosition + column) === 32) column++;
    const first = state.input.charCodeAt(linePosition + column);
    if (first === 0) {
      if (contentIndent >= 0) {
        if (column > contentIndent) valueEnd = linePosition + column;
      } else if (column > 0) valueEnd = linePosition + column;
      break;
    }
    if (linePosition === state.lineStart && testDocumentSeparator(state, linePosition)) break;
    if (!detectedIndent && contentIndent === -1 && isEol(first)) maxLeadingIndent = Math.max(maxLeadingIndent, column);
    if (!detectedIndent && contentIndent === -1 && !isEol(first)) {
      if (first === 9 && column < parentIndent) {
        state.position = linePosition + column;
        throwError(state, "tab characters must not be used in indentation");
      }
      if (column < maxLeadingIndent) {
        state.position = linePosition + column;
        throwError(state, "bad indentation of a mapping entry");
      }
    }
    if (contentIndent === -1 && first !== 0 && !isEol(first) && column < parentIndent) {
      state.lineIndent = column;
      state.position = linePosition + column;
      break;
    }
    if (!detectedIndent && first !== 0 && !isEol(first) && contentIndent === -1) contentIndent = column;
    const requiredIndent = contentIndent === -1 ? parentIndent + 1 : contentIndent;
    if (first !== 0 && !isEol(first) && column < requiredIndent) {
      state.lineIndent = column;
      state.position = linePosition + column;
      break;
    }
    skipUntilLineEnd(state);
    valueEnd = state.position;
    if (isEol(state.input.charCodeAt(state.position))) {
      consumeLineBreak(state);
      valueEnd = state.position;
    }
  }
  checkPrintable(state, valueStart, valueEnd);
  addScalarEvent(state, valueStart, valueEnd, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, style, chomping, contentIndent);
  return true;
}
function canStartPlainScalar(state, nodeContext) {
  const ch = state.input.charCodeAt(state.position);
  const inFlow = nodeContext === CONTEXT_FLOW_IN;
  if (ch === 0 || isWsOrEol(ch) || ch === 35 || ch === 38 || ch === 42 || ch === 33 || ch === 124 || ch === 62 || ch === 39 || ch === 34 || ch === 37 || ch === 64 || ch === 96 || inFlow && isFlowIndicator(ch)) return false;
  if (ch === 63 || ch === 45) {
    const following = state.input.charCodeAt(state.position + 1);
    if (isWsOrEolOrEnd(following) || inFlow && isFlowIndicator(following)) return false;
  }
  return true;
}
function readPlainScalar(state, nodeIndent, nodeContext, props) {
  if (!canStartPlainScalar(state, nodeContext)) return false;
  const start = state.position;
  let end = state.position;
  let ch = state.input.charCodeAt(state.position);
  const inFlow = nodeContext === CONTEXT_FLOW_IN;
  let multiline = false;
  while (ch !== 0) {
    if (state.position === state.lineStart && testDocumentSeparator(state)) break;
    if (ch === 58) {
      const following = state.input.charCodeAt(state.position + 1);
      if (isWsOrEolOrEnd(following) || inFlow && isFlowIndicator(following)) break;
    } else if (ch === 35) {
      if (isWsOrEol(state.input.charCodeAt(state.position - 1))) break;
    } else if (inFlow && isFlowIndicator(ch)) break;
    else if (isEol(ch)) {
      const savedPosition = state.position;
      const savedLine = state.line;
      const savedLineStart = state.lineStart;
      const savedLineIndent = state.lineIndent;
      skipSeparationSpace(state, false);
      if (state.lineIndent >= nodeIndent) {
        multiline = true;
        ch = state.input.charCodeAt(state.position);
        continue;
      }
      state.position = savedPosition;
      state.line = savedLine;
      state.lineStart = savedLineStart;
      state.lineIndent = savedLineIndent;
      break;
    }
    if (!isWhiteSpace(ch)) end = state.position + 1;
    ch = state.input.charCodeAt(++state.position);
  }
  if (end === start) return false;
  checkPrintable(state, start, end);
  addScalarEvent(state, start, end, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, 1, 1, -1, !multiline);
  return true;
}
function skipFlowSeparationSpace(state, nodeIndent) {
  const startLine = state.line;
  skipSeparationSpace(state, true);
  if (state.line > startLine && state.lineIndent < nodeIndent || state.firstTabInLine !== -1 && state.lineIndent < nodeIndent) throwError(state, "deficient indentation");
}
function readFlowCollection(state, nodeIndent, props) {
  const ch = state.input.charCodeAt(state.position);
  const isMapping = ch === 123;
  const start = state.position;
  let readNext = true;
  if (ch !== 91 && ch !== 123) return false;
  const terminator = isMapping ? 125 : 93;
  if (isMapping) addMappingEvent(state, start, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, 2);
  else addSequenceEvent(state, start, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, 2);
  state.position++;
  while (state.input.charCodeAt(state.position) !== 0) {
    skipFlowSeparationSpace(state, nodeIndent);
    let ch2 = state.input.charCodeAt(state.position);
    if (ch2 === terminator) {
      state.position++;
      addPopEvent(state);
      return true;
    } else if (!readNext) throwError(state, "missed comma between flow collection entries");
    else if (ch2 === 44) throwError(state, "expected the node content, but found ','");
    let isPair = false;
    let isExplicitPair = false;
    if (ch2 === 63 && isWsOrEol(state.input.charCodeAt(state.position + 1))) {
      isPair = isExplicitPair = true;
      state.position += 1;
      skipFlowSeparationSpace(state, nodeIndent);
    }
    const entryLine = state.line;
    const entryStart = snapshotState(state);
    const keyWasRead = parseNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true);
    skipFlowSeparationSpace(state, nodeIndent);
    ch2 = state.input.charCodeAt(state.position);
    if ((isMapping || isExplicitPair || state.line === entryLine) && ch2 === 58) {
      isPair = true;
      state.position++;
      skipFlowSeparationSpace(state, nodeIndent);
      if (!isMapping) {
        insertFlowPairMappingEvent(state, entryStart);
        if (!keyWasRead) addEmptyScalarEvent(state);
      } else if (!keyWasRead) addEmptyScalarEvent(state);
      if (!parseNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true)) addEmptyScalarEvent(state);
      skipFlowSeparationSpace(state, nodeIndent);
      if (!isMapping) addPopEvent(state);
    } else if (isMapping && isPair) {
      if (!keyWasRead) addEmptyScalarEvent(state);
      addEmptyScalarEvent(state);
    } else if (isMapping) addEmptyScalarEvent(state);
    else if (isPair) {
      insertFlowPairMappingEvent(state, entryStart);
      if (!keyWasRead) addEmptyScalarEvent(state);
      addEmptyScalarEvent(state);
      addPopEvent(state);
    }
    ch2 = state.input.charCodeAt(state.position);
    if (ch2 === 44) {
      readNext = true;
      state.position++;
    } else readNext = false;
  }
  throwError(state, "unexpected end of the stream within a flow collection");
}
function readBlockSequence(state, nodeIndent, props) {
  if (state.firstTabInLine !== -1 || state.input.charCodeAt(state.position) !== 45 || !isWsOrEolOrEnd(state.input.charCodeAt(state.position + 1))) return false;
  addSequenceEvent(state, state.position, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, 1);
  while (state.input.charCodeAt(state.position) === 45 && isWsOrEolOrEnd(state.input.charCodeAt(state.position + 1))) {
    if (state.firstTabInLine !== -1) {
      state.position = state.firstTabInLine;
      throwError(state, "tab characters must not be used in indentation");
    }
    const entryLine = state.line;
    state.position++;
    const hadBreak = skipSeparationSpace(state, true) > 0;
    if (state.firstTabInLine !== -1 && state.input.charCodeAt(state.position) === 45 && isWsOrEolOrEnd(state.input.charCodeAt(state.position + 1))) throwError(state, "bad indentation of a sequence entry");
    if (hadBreak && state.lineIndent <= nodeIndent) addEmptyScalarEvent(state);
    else parseNode(state, nodeIndent, CONTEXT_BLOCK_IN, false, true);
    skipSeparationSpace(state, true);
    if (state.lineIndent < nodeIndent || state.position >= state.length) break;
    if (state.lineIndent > nodeIndent) throwError(state, "bad indentation of a sequence entry");
    if (state.line === entryLine && state.input.charCodeAt(state.position) === 45 && isWsOrEolOrEnd(state.input.charCodeAt(state.position + 1))) throwError(state, "bad indentation of a sequence entry");
  }
  addPopEvent(state);
  return true;
}
function readBlockMapping(state, nodeIndent, flowIndent, props) {
  let atExplicitKey = false;
  let detected = false;
  let mappingOpened = false;
  let pendingExplicitKey = false;
  if (state.firstTabInLine !== -1) return false;
  let ch = state.input.charCodeAt(state.position);
  while (ch !== 0) {
    if (!atExplicitKey && state.firstTabInLine !== -1) {
      state.position = state.firstTabInLine;
      throwError(state, "tab characters must not be used in indentation");
    }
    const following = state.input.charCodeAt(state.position + 1);
    const entryLine = state.line;
    if ((ch === 63 || ch === 58) && isWsOrEolOrEnd(following)) {
      if (!mappingOpened) {
        addMappingEvent(state, state.position, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, 1);
        mappingOpened = true;
      }
      if (ch === 63) {
        if (atExplicitKey) addEmptyScalarEvent(state);
        detected = true;
        atExplicitKey = true;
      } else if (atExplicitKey) atExplicitKey = false;
      else {
        addEmptyScalarEvent(state);
        detected = true;
        atExplicitKey = false;
      }
      state.position += 1;
      pendingExplicitKey = true;
    } else {
      if (atExplicitKey) {
        addEmptyScalarEvent(state);
        atExplicitKey = false;
      }
      const beforeKey = snapshotState(state);
      if (!parseNode(state, flowIndent, CONTEXT_FLOW_OUT, false, true)) break;
      if (state.line === entryLine) {
        ch = state.input.charCodeAt(state.position);
        while (isWhiteSpace(ch)) ch = state.input.charCodeAt(++state.position);
        if (ch === 58) {
          ch = state.input.charCodeAt(++state.position);
          if (!isWsOrEolOrEnd(ch)) throwError(state, "a whitespace character is expected after the key-value separator within a block mapping");
          if (!mappingOpened) {
            restoreState(state, beforeKey);
            addMappingEvent(state, beforeKey.position, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, 1);
            mappingOpened = true;
            parseNode(state, flowIndent, CONTEXT_FLOW_OUT, false, true);
            ch = state.input.charCodeAt(state.position);
            while (isWhiteSpace(ch)) ch = state.input.charCodeAt(++state.position);
            state.position++;
          }
          detected = true;
          atExplicitKey = false;
          pendingExplicitKey = false;
        } else if (detected) throwError(state, "expected ':' after a mapping key");
        else {
          if (props.anchorStart !== NO_RANGE$1 || props.tagStart !== NO_RANGE$1) {
            restoreState(state, beforeKey);
            return false;
          }
          return true;
        }
      } else if (detected) throwError(state, "can not read a block mapping entry; a multiline key may not be an implicit key");
      else {
        if (props.anchorStart !== NO_RANGE$1 || props.tagStart !== NO_RANGE$1) {
          restoreState(state, beforeKey);
          return false;
        }
        return true;
      }
    }
    if (parseNode(state, nodeIndent, CONTEXT_BLOCK_OUT, true, pendingExplicitKey)) pendingExplicitKey = false;
    if (!atExplicitKey) {
      if (pendingExplicitKey) {
        addEmptyScalarEvent(state);
        pendingExplicitKey = false;
      }
    }
    skipSeparationSpace(state, true);
    ch = state.input.charCodeAt(state.position);
    if ((state.line === entryLine || state.lineIndent > nodeIndent) && ch !== 0) throwError(state, "bad indentation of a mapping entry");
    else if (state.lineIndent < nodeIndent) break;
  }
  if (!detected) return false;
  if (atExplicitKey) addEmptyScalarEvent(state);
  if (mappingOpened) addPopEvent(state);
  return true;
}
function parseNode(state, parentIndent, nodeContext, allowToSeek, allowCompact, allowPropertyMapping = true) {
  if (state.depth >= state.maxDepth) throwError(state, `nesting exceeded maxDepth (${state.maxDepth})`);
  state.depth++;
  let indentStatus = 1;
  let atNewLine = false;
  let hasContent = false;
  let propertyStart = null;
  const props = emptyProperties();
  let allowBlockScalars = nodeContext === CONTEXT_BLOCK_OUT || nodeContext === CONTEXT_BLOCK_IN;
  let allowBlockCollections = allowBlockScalars;
  const allowBlockStyles = allowBlockScalars;
  if (allowToSeek && skipSeparationSpace(state, true)) {
    atNewLine = true;
    if (state.lineIndent > parentIndent) indentStatus = 1;
    else if (state.lineIndent === parentIndent) indentStatus = 0;
    else indentStatus = -1;
  }
  if (state.position === state.lineStart && testDocumentSeparator(state)) {
    state.depth--;
    return false;
  }
  if (indentStatus === 1) while (true) {
    const ch = state.input.charCodeAt(state.position);
    const propertyState = snapshotState(state);
    if (atNewLine && indentStatus !== 1 && (ch === 33 || ch === 38)) break;
    if (atNewLine && allowBlockStyles && (props.tagStart !== NO_RANGE$1 || props.anchorStart !== NO_RANGE$1) && (ch === 33 || ch === 38)) {
      const fallbackState = snapshotState(state);
      const flowIndent = parentIndent + 1;
      if (readBlockMapping(state, state.position - state.lineStart, flowIndent, props) && state.events[fallbackState.eventsLength]?.type === 3) {
        state.depth--;
        return true;
      }
      restoreState(state, fallbackState);
    }
    if (atNewLine && (ch === 33 && props.tagStart !== NO_RANGE$1 || ch === 38 && props.anchorStart !== NO_RANGE$1)) break;
    if (!readTagProperty(state, props, nodeContext === CONTEXT_FLOW_IN) && !readAnchorProperty(state, props)) break;
    if (propertyStart === null) propertyStart = propertyState;
    if (skipSeparationSpace(state, true)) {
      atNewLine = true;
      allowBlockCollections = allowBlockStyles;
      if (state.lineIndent > parentIndent) indentStatus = 1;
      else if (state.lineIndent === parentIndent) indentStatus = 0;
      else indentStatus = -1;
    } else allowBlockCollections = false;
  }
  if (allowBlockCollections) allowBlockCollections = atNewLine || allowCompact;
  if (indentStatus === 1 || nodeContext === CONTEXT_BLOCK_OUT) {
    const flowIndent = nodeContext === CONTEXT_FLOW_IN || nodeContext === CONTEXT_FLOW_OUT ? parentIndent : parentIndent + 1;
    const blockIndent = state.position - state.lineStart;
    if (indentStatus === 1) if (allowBlockCollections && (readBlockSequence(state, blockIndent, props) || readBlockMapping(state, blockIndent, flowIndent, props)) || readFlowCollection(state, flowIndent, props)) hasContent = true;
    else {
      const ch = state.input.charCodeAt(state.position);
      if (propertyStart !== null && allowPropertyMapping && allowBlockStyles && !allowBlockCollections && ch !== 124 && ch !== 62) {
        const fallbackState = snapshotState(state);
        const propertyIndent = propertyStart.position - propertyStart.lineStart;
        restoreState(state, propertyStart);
        if (readBlockMapping(state, propertyIndent, flowIndent, emptyProperties()) && state.events[fallbackState.eventsLength]?.type === 3) hasContent = true;
        else restoreState(state, fallbackState);
      }
      if (!hasContent && (allowBlockScalars && readBlockScalar(state, flowIndent, props) || readSingleQuotedScalar(state, flowIndent, props) || readDoubleQuotedScalar(state, flowIndent, props) || readAlias(state, props) || readPlainScalar(state, flowIndent, nodeContext, props))) hasContent = true;
    }
    else if (indentStatus === 0) hasContent = allowBlockCollections && readBlockSequence(state, blockIndent, props);
  }
  allowBlockScalars = allowBlockScalars && !hasContent;
  if (!hasContent && (props.anchorStart !== NO_RANGE$1 || props.tagStart !== NO_RANGE$1 || allowBlockScalars)) {
    addScalarEvent(state, NO_RANGE$1, NO_RANGE$1, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, 1);
    hasContent = true;
  }
  state.depth--;
  return hasContent || props.anchorStart !== NO_RANGE$1 || props.tagStart !== NO_RANGE$1;
}
function readDirective(state) {
  if (state.lineIndent > 0 || state.input.charCodeAt(state.position) !== 37) return false;
  state.position++;
  const nameStart = state.position;
  while (state.input.charCodeAt(state.position) !== 0 && !isWsOrEol(state.input.charCodeAt(state.position))) state.position++;
  const name = state.input.slice(nameStart, state.position);
  const args = [];
  if (name.length === 0) throwError(state, "directive name must not be less than one character in length");
  while (state.input.charCodeAt(state.position) !== 0 && !isEol(state.input.charCodeAt(state.position))) {
    while (isWhiteSpace(state.input.charCodeAt(state.position))) state.position++;
    if (state.input.charCodeAt(state.position) === 35 || isEol(state.input.charCodeAt(state.position)) || state.input.charCodeAt(state.position) === 0) break;
    const start = state.position;
    while (state.input.charCodeAt(state.position) !== 0 && !isWsOrEol(state.input.charCodeAt(state.position))) state.position++;
    args.push(state.input.slice(start, state.position));
  }
  if (isEol(state.input.charCodeAt(state.position))) consumeLineBreak(state);
  if (name === "YAML") {
    if (state.directives.some((directive) => directive.kind === "yaml")) throwError(state, "duplication of %YAML directive");
    if (args.length !== 1) throwError(state, "YAML directive accepts exactly one argument");
    const match = /^([0-9]+)\.([0-9]+)$/.exec(args[0]);
    if (match === null) throwError(state, "ill-formed argument of the YAML directive");
    if (parseInt(match[1], 10) !== 1) throwError(state, "unacceptable YAML version of the document");
    state.directives.push({
      kind: "yaml",
      version: args[0]
    });
  } else if (name === "TAG") {
    if (args.length !== 2) throwError(state, "TAG directive accepts exactly two arguments");
    const [handle, prefix] = args;
    if (!PATTERN_TAG_HANDLE.test(handle)) throwError(state, "ill-formed tag handle (first argument) of the TAG directive");
    if (HAS_OWN.call(state.tagHandlers, handle)) throwError(state, `there is a previously declared suffix for "${handle}" tag handle`);
    if (!PATTERN_TAG_PREFIX.test(prefix)) throwError(state, "ill-formed tag prefix (second argument) of the TAG directive");
    state.tagHandlers[handle] = prefix;
    state.directives.push({
      kind: "tag",
      handle,
      prefix
    });
  }
  return true;
}
function readDocument(state) {
  state.directives = [];
  state.tagHandlers = /* @__PURE__ */ Object.create(null);
  let hasDirectives = false;
  skipSeparationSpace(state, true);
  while (readDirective(state)) {
    hasDirectives = true;
    skipSeparationSpace(state, true);
  }
  let explicitStart = false;
  let explicitEnd = false;
  let allowCompact = true;
  if (state.lineIndent === 0 && state.input.charCodeAt(state.position) === 45 && state.input.charCodeAt(state.position + 1) === 45 && state.input.charCodeAt(state.position + 2) === 45 && isWsOrEolOrEnd(state.input.charCodeAt(state.position + 3))) {
    explicitStart = true;
    const markerLine = state.line;
    state.position += 3;
    skipSeparationSpace(state, true);
    allowCompact = state.line > markerLine;
  } else if (hasDirectives) throwError(state, "directives end mark is expected");
  const documentEventIndex = state.events.length;
  if (!explicitStart && state.position === state.lineStart && state.input.charCodeAt(state.position) === 46 && testDocumentSeparator(state)) {
    state.position += 3;
    skipSeparationSpace(state, true);
    return;
  }
  addDocumentEvent(state, explicitStart, false);
  if (!parseNode(state, state.lineIndent - 1, CONTEXT_BLOCK_OUT, false, allowCompact, allowCompact)) addEmptyScalarEvent(state);
  skipSeparationSpace(state, true);
  if (state.position === state.lineStart && testDocumentSeparator(state)) {
    explicitEnd = state.input.charCodeAt(state.position) === 46;
    if (explicitEnd) {
      const markerLine = state.line;
      state.position += 3;
      skipSeparationSpace(state, true);
      if (state.line === markerLine && state.position < state.length) throwError(state, "end of the stream or a document separator is expected");
    }
  }
  const documentEvent = state.events[documentEventIndex];
  if (documentEvent?.type === 1) documentEvent.explicitEnd = explicitEnd;
  addPopEvent(state);
  if (!explicitEnd && state.position < state.length && !(state.position === state.lineStart && testDocumentSeparator(state))) throwError(state, "end of the stream or a document separator is expected");
}
function parseEvents(input, options) {
  const length = input.length;
  const state = {
    ...DEFAULT_PARSER_OPTIONS,
    ...options,
    input: `${input}\0`,
    length,
    position: 0,
    line: 0,
    lineStart: 0,
    lineIndent: 0,
    firstTabInLine: -1,
    depth: 0,
    directives: [],
    tagHandlers: /* @__PURE__ */ Object.create(null),
    events: []
  };
  const nullpos = input.indexOf("\0");
  if (nullpos !== -1) throwErrorAt(input, nullpos, "null byte is not allowed in input", state.filename);
  if (state.input.charCodeAt(state.position) === 65279) state.position++;
  while (state.position < state.length) {
    skipSeparationSpace(state, true);
    if (state.position >= state.length) break;
    const documentStart = state.position;
    readDocument(state);
    if (state.position === documentStart)
      throwError(state, "can not read a document");
  }
  return state.events;
}
var DEFAULT_LOAD_OPTIONS = {
  ...DEFAULT_PARSER_OPTIONS,
  ...DEFAULT_CONSTRUCTOR_OPTIONS
};
function loadDocuments(input, options = {}) {
  const opts = {
    ...DEFAULT_LOAD_OPTIONS,
    ...options
  };
  const source = String(input);
  const PARSER_OPT_KEYS = Object.keys(DEFAULT_PARSER_OPTIONS);
  const CONSTRUCTOR_OPT_KEYS = Object.keys(DEFAULT_CONSTRUCTOR_OPTIONS);
  return constructFromEvents(parseEvents(source, pick(opts, PARSER_OPT_KEYS)), {
    ...pick(opts, CONSTRUCTOR_OPT_KEYS),
    source
  });
}
function load(input, options) {
  const documents = loadDocuments(input, options);
  if (documents.length === 0) throw new YAMLException("expected a document, but the input is empty");
  if (documents.length === 1) return documents[0];
  throw new YAMLException("expected a single document in the stream, but found more");
}
var INVALID = Symbol("INVALID");
var VISIT_BREAK = Symbol("visit:break");
var VISIT_SKIP = Symbol("visit:skip");
var ESCAPE_SEQUENCES = {};
ESCAPE_SEQUENCES[0] = "\\0";
ESCAPE_SEQUENCES[7] = "\\a";
ESCAPE_SEQUENCES[8] = "\\b";
ESCAPE_SEQUENCES[9] = "\\t";
ESCAPE_SEQUENCES[10] = "\\n";
ESCAPE_SEQUENCES[11] = "\\v";
ESCAPE_SEQUENCES[12] = "\\f";
ESCAPE_SEQUENCES[13] = "\\r";
ESCAPE_SEQUENCES[27] = "\\e";
ESCAPE_SEQUENCES[34] = '\\"';
ESCAPE_SEQUENCES[92] = "\\\\";
ESCAPE_SEQUENCES[133] = "\\N";
ESCAPE_SEQUENCES[160] = "\\_";
ESCAPE_SEQUENCES[8232] = "\\L";
ESCAPE_SEQUENCES[8233] = "\\P";
var DEFAULT_PRESENTER_OPTIONS = {
  indent: 2,
  seqNoIndent: false,
  seqInlineFirst: true,
  sortKeys: false,
  lineWidth: 80,
  flowBracketPadding: false,
  flowSkipCommaSpace: false,
  flowSkipColonSpace: false,
  quoteFlowKeys: false,
  quoteStyle: "single",
  forceQuotes: false,
  tagBeforeAnchor: false
};
var DEFAULT_DUMP_SCHEMA = YAML11_SCHEMA.withTags({
  ...intYaml11Tag,
  resolve: (source, isExplicit, tagName) => {
    const result = intYaml11Tag.resolve(source, isExplicit, tagName);
    return result === NOT_RESOLVED ? intCoreTag.resolve(source, isExplicit, tagName) : result;
  }
}, {
  ...floatYaml11Tag,
  resolve: (source, isExplicit, tagName) => {
    const result = floatYaml11Tag.resolve(source, isExplicit, tagName);
    return result === NOT_RESOLVED ? floatCoreTag.resolve(source, isExplicit, tagName) : result;
  }
});
var DEFAULT_DUMP_OPTIONS = {
  ...DEFAULT_PRESENTER_OPTIONS,
  schema: DEFAULT_DUMP_SCHEMA,
  skipInvalid: false,
  noRefs: false,
  flowLevel: -1,
  transform: () => {
  }
};

// src/graphify.ts
import { existsSync, readFileSync } from "node:fs";
import { join as join2 } from "node:path";

// src/paths.ts
import { realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
function resolvedRoot(repoRoot) {
  const root = resolve(repoRoot);
  return tryRealpath(root) ?? root;
}
function insideRepo(repoRoot, rel) {
  const root = resolvedRoot(repoRoot);
  const abs = resolve(root, rel);
  const candidate = resolveAsFarAsExists(abs);
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : null;
}
function tryRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}
function resolveAsFarAsExists(path) {
  const tail = [];
  let dir = path;
  for (; ; ) {
    const real = tryRealpath(dir);
    if (real !== null) return tail.length === 0 ? real : join(real, ...tail);
    const parent = dirname(dir);
    if (parent === dir) return path;
    tail.unshift(basename(dir));
    dir = parent;
  }
}
function repoRelative(repoRoot, path) {
  const abs = insideRepo(repoRoot, path);
  if (abs === null) return null;
  const rel = relative(resolvedRoot(repoRoot), abs);
  if (rel === "") return null;
  return rel.split(sep).join("/");
}

// src/graphify.ts
var IMPORT_TYPES = /* @__PURE__ */ new Set(["imports", "import", "calls", "inherits", "extends"]);
var str = (v) => typeof v === "string" && v ? v : null;
var isNil = (v) => v === null || v === void 0;
function graphifyGraphPath(repoRoot) {
  return join2(repoRoot, "graphify-out", "graph.json");
}
function readGraphify(repoRoot, moduleOf) {
  const path = graphifyGraphPath(repoRoot);
  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const doc = parsed;
  if (!Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) return null;
  const fileOf = /* @__PURE__ */ new Map();
  for (const raw of doc.nodes) {
    if (isNil(raw)) continue;
    const id = str(raw.id);
    const file = str(raw.file) ?? str(raw.path) ?? str(raw.file_path);
    if (!id || !file) continue;
    const rel = repoRelative(repoRoot, file);
    if (rel === null) continue;
    fileOf.set(id, rel);
  }
  const acc = /* @__PURE__ */ new Map();
  for (const raw of doc.edges) {
    if (isNil(raw)) continue;
    const type = (str(raw.type) ?? str(raw.kind) ?? "").toLowerCase();
    if (!IMPORT_TYPES.has(type)) continue;
    const from = str(raw.source);
    const to = str(raw.target);
    if (!from || !to) continue;
    const fa = fileOf.get(from);
    const fb = fileOf.get(to);
    if (!fa || !fb) continue;
    const ma = moduleOf(fa);
    const mb = moduleOf(fb);
    if (ma === mb) continue;
    const key = `${ma}\0${mb}`;
    const existing = acc.get(key);
    if (existing) existing.weight += 1;
    else acc.set(key, { from: ma, to: mb, weight: 1 });
  }
  return [...acc.values()].sort(
    (x, y) => y.weight - x.weight || compare(x.from, y.from) || compare(x.to, y.to)
  );
}

// src/spine.ts
function pnpmPackageGlobs(text) {
  let doc;
  try {
    doc = load(text);
  } catch {
    return [];
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return [];
  const packages = doc.packages;
  if (!Array.isArray(packages)) return [];
  return packages.filter((item) => typeof item === "string");
}
function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
var MANIFEST_MARKERS = ["go.mod", "Cargo.toml", "pyproject.toml"];
var IGNORED_DIR_NAMES = /* @__PURE__ */ new Set(["node_modules", "vendor", ".git", "dist", "build", "target"]);
var MANIFEST_SCAN_MAX_DEPTH = 3;
function discoverManifestRoots(repoRoot) {
  const found = [];
  function walk(relDir, depth) {
    const abs = insideRepo(repoRoot, relDir);
    if (abs === null) return;
    if (MANIFEST_MARKERS.some((marker) => existsSync2(join3(abs, marker)))) found.push(relDir);
    if (depth >= MANIFEST_SCAN_MAX_DEPTH) return;
    for (const entry of readdirSafe(abs)) {
      if (entry.startsWith(".") || IGNORED_DIR_NAMES.has(entry)) continue;
      if (isDirectory(join3(abs, entry))) {
        walk(relDir === "." ? entry : `${relDir}/${entry}`, depth + 1);
      }
    }
  }
  walk(".", 0);
  return found;
}
function subdirectories(repoRoot, relDir) {
  const abs = insideRepo(repoRoot, relDir);
  if (abs === null) return [];
  return readdirSafe(abs).filter((entry) => isDirectory(join3(abs, entry)));
}
function expandGlob(repoRoot, glob) {
  let bases = ["."];
  for (const segment of glob.split("/")) {
    if (segment === "*") {
      const next = [];
      for (const base of bases) {
        for (const entry of subdirectories(repoRoot, base)) {
          next.push(base === "." ? entry : `${base}/${entry}`);
        }
      }
      bases = next;
    } else {
      bases = bases.map((base) => base === "." ? segment : `${base}/${segment}`);
    }
  }
  return bases.filter((rel) => rel !== "." && insideRepo(repoRoot, rel) !== null);
}
function workspaceRoots(repoRoot) {
  const globs = [];
  const ws = join3(repoRoot, "pnpm-workspace.yaml");
  if (existsSync2(ws)) {
    try {
      globs.push(...pnpmPackageGlobs(readFileSync2(ws, "utf8")));
    } catch {
    }
  }
  const pkg = join3(repoRoot, "package.json");
  if (existsSync2(pkg)) {
    try {
      const parsed = JSON.parse(readFileSync2(pkg, "utf8"));
      const w = parsed.workspaces;
      const list = Array.isArray(w) ? w : w?.packages;
      if (Array.isArray(list)) {
        for (const g of list) if (typeof g === "string") globs.push(g);
      }
    } catch {
    }
  }
  const out = [];
  for (const glob of globs) {
    if (glob.startsWith("!")) continue;
    out.push(...expandGlob(repoRoot, glob));
  }
  if (out.length === 0) {
    const markerRoots = discoverManifestRoots(repoRoot);
    if (markerRoots.length > 1) out.push(...markerRoots);
  }
  return [...new Set(out)].sort();
}
var ROOT_MODULE = "(repo root)";
function twoSegmentModule(path) {
  const parts = path.split("/");
  return parts.length <= 1 ? ROOT_MODULE : parts.slice(0, Math.min(2, parts.length - 1)).join("/");
}
function filesByModule(files, moduleOf) {
  const byName = /* @__PURE__ */ new Map();
  files.forEach((path, id) => {
    const name = moduleOf(path);
    const list = byName.get(name);
    if (list) list.push(id);
    else byName.set(name, [id]);
  });
  return byName;
}
function declaredSpine(repoRoot, files) {
  const roots = workspaceRoots(repoRoot);
  const manifestBased = roots.length > 1 || roots.length === 1 && roots[0] !== ".";
  let moduleOf;
  if (manifestBased) {
    const sorted = [...roots].sort((a, b) => b.length - a.length);
    moduleOf = (path) => sorted.find((r) => path === r || path.startsWith(`${r}/`)) ?? twoSegmentModule(path);
  } else {
    moduleOf = twoSegmentModule;
  }
  const imports = readGraphify(repoRoot, moduleOf) ?? [];
  const source = imports.length > 0 ? "graphify" : manifestBased ? "manifests" : "directories";
  const names = new Set(filesByModule(files, moduleOf).keys());
  for (const e of imports) {
    names.add(e.from);
    names.add(e.to);
  }
  const modules = [...names].sort();
  return { source, modules, moduleOf, imports };
}

// src/layers.ts
function layerRanks(modules, imports) {
  if (imports.length === 0) return null;
  const out = new Map(modules.map((m) => [m, []]));
  const inn = new Map(modules.map((m) => [m, []]));
  for (const e of imports) {
    if (!out.has(e.from) || !inn.has(e.to)) continue;
    out.get(e.from)?.push(e.to);
    inn.get(e.to)?.push(e.from);
  }
  const order = [];
  const seen = /* @__PURE__ */ new Set();
  const visit = (n) => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const to of (out.get(n) ?? []).slice().sort()) visit(to);
    order.push(n);
  };
  for (const m of [...modules].sort()) visit(m);
  const compOf = /* @__PURE__ */ new Map();
  let comps = 0;
  const assign = (n, id) => {
    if (compOf.has(n)) return;
    compOf.set(n, id);
    for (const from of (inn.get(n) ?? []).slice().sort()) assign(from, id);
  };
  for (const n of [...order].reverse()) {
    if (!compOf.has(n)) assign(n, comps++);
  }
  const compIn = new Array(comps).fill(0);
  const compOut = Array.from({ length: comps }, () => []);
  const seenEdge = /* @__PURE__ */ new Set();
  for (const e of imports) {
    const a = compOf.get(e.from);
    const b = compOf.get(e.to);
    if (a === void 0 || b === void 0 || a === b) continue;
    const key = `${a}->${b}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    compOut[a]?.push(b);
    compIn[b] = (compIn[b] ?? 0) + 1;
  }
  const compRank = new Array(comps).fill(0);
  let frontier = compIn.map((d, i) => d === 0 ? i : -1).filter((i) => i >= 0);
  let depth = 0;
  while (frontier.length > 0) {
    const next = [];
    for (const c of frontier) {
      compRank[c] = depth;
      for (const to of compOut[c] ?? []) {
        compIn[to] = (compIn[to] ?? 0) - 1;
        if (compIn[to] === 0) next.push(to);
      }
    }
    frontier = [...new Set(next)].sort((a, b) => a - b);
    depth++;
  }
  const rank2 = /* @__PURE__ */ new Map();
  for (const m of modules) {
    const c = compOf.get(m);
    rank2.set(m, c === void 0 ? 0 : compRank[c] ?? 0);
  }
  return rank2;
}

// src/stability.ts
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}
function overlap(newSet, oldSet) {
  if (newSet.size === 0 && oldSet.size === 0) return 1;
  return jaccard(newSet, oldSet);
}
function remapClusters(oldClusters, newClusters, opts = {}) {
  const threshold = opts.threshold ?? 0.5;
  const oldSets = /* @__PURE__ */ new Map();
  for (const [id, members] of oldClusters) {
    if (!Number.isInteger(id) || id < 0) continue;
    oldSets.set(id, new Set(members));
  }
  let nextId = oldSets.size === 0 ? 0 : Math.max(...oldSets.keys()) + 1;
  const claimed = /* @__PURE__ */ new Set();
  const remap = /* @__PURE__ */ new Map();
  const candidates = [];
  for (const [newId2, members] of newClusters) {
    const set = new Set(members);
    for (const [oldId, oldSet] of oldSets) {
      const score = overlap(set, oldSet);
      if (score >= threshold) candidates.push({ newId: newId2, oldId, score });
    }
  }
  candidates.sort((x, y) => y.score - x.score || x.newId - y.newId || x.oldId - y.oldId);
  const assigned = /* @__PURE__ */ new Map();
  for (const { newId: newId2, oldId } of candidates) {
    if (assigned.has(newId2) || claimed.has(oldId)) continue;
    assigned.set(newId2, oldId);
    claimed.add(oldId);
  }
  const newIds = [...newClusters.keys()].sort((a, b) => a - b);
  for (const newId2 of newIds) {
    if (!assigned.has(newId2)) assigned.set(newId2, nextId++);
  }
  for (const newId2 of newIds) {
    const stable = assigned.get(newId2);
    if (stable !== void 0) remap.set(newId2, stable);
  }
  return remap;
}

// src/working-sets.ts
function workingSets(byCommunity, edges, files, moduleOf) {
  const out = [];
  for (const [, members] of [...byCommunity.entries()].sort((x, y) => x[0] - y[0])) {
    const paths = members.map((n) => files[n]).filter((p) => p !== void 0).sort(compare);
    const modules = [...new Set(paths.map(moduleOf))].sort(compare);
    if (modules.length < 2) continue;
    const memberIds = new Set(members);
    const linked = /* @__PURE__ */ new Set();
    for (const e of edges) {
      if (isSyntheticBridge(e) || edgeWeight(e) === 0) continue;
      if (!memberIds.has(e.a) || !memberIds.has(e.b)) continue;
      const pa = files[e.a];
      const pb = files[e.b];
      if (pa === void 0 || pb === void 0) continue;
      const ma = moduleOf(pa);
      const mb = moduleOf(pb);
      if (ma === mb) continue;
      linked.add(ma);
      linked.add(mb);
    }
    if (modules.some((m) => !linked.has(m))) continue;
    if (paths.length === 2) {
      const [a, b] = paths;
      if (a !== void 0 && b !== void 0 && classifyPair(a, b) !== "candidate") continue;
    }
    const primary = nameCluster(members, edges, files, 1)[0];
    const name = primary ?? paths[0];
    if (name === void 0) continue;
    out.push({ name, modules, files: paths });
  }
  return out.sort((x, y) => y.files.length - x.files.length || compare(x.name, y.name));
}

// src/config.ts
import { existsSync as existsSync3, readFileSync as readFileSync3 } from "node:fs";
import { join as join4 } from "node:path";

// src/lexical.ts
var STOPWORDS = new Set(
  `a an the is are was were be been being to of and or in on at by for with from
   as that this these those it its into over under given when returns return
   each every both never no not only exists must should would could rather
   than same across between per via own can will one two three does do did
   has have had so if else yet also still even out about after before while
   all any none there here where which who whom whose what how many more most
   such other another`.split(/\s+/)
);
function tokenize(text) {
  return text.split(/[/.\-_\s]+/).flatMap((word) => word.split(/(?<=[a-z0-9])(?=[A-Z0-9])/)).map((t) => t.toLowerCase()).filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}
function idf(df, candidateCount, token) {
  const d = df.get(token);
  if (d === void 0 || d === 0) return 0;
  return Math.log(candidateCount / d);
}
function rank(criteria, candidates) {
  const queryTokens = /* @__PURE__ */ new Set();
  for (const c of criteria) for (const t of tokenize(c)) queryTokens.add(t);
  const candidateTokens = /* @__PURE__ */ new Map();
  const df = /* @__PURE__ */ new Map();
  for (const file of candidates) {
    const toks = new Set(tokenize(file));
    candidateTokens.set(file, toks);
    for (const t of toks) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = candidates.length;
  let denom = 0;
  for (const t of queryTokens) denom += idf(df, n, t);
  const scored = candidates.map((file) => {
    if (denom <= 0) return { file, score: 0 };
    const toks = candidateTokens.get(file);
    let s = 0;
    if (toks) {
      for (const t of queryTokens) if (toks.has(t)) s += idf(df, n, t);
    }
    return { file, score: s / denom };
  });
  scored.sort((a, b) => b.score - a.score || compare(a.file, b.file));
  return scored;
}
var CONFIDENCE_FLOOR = 0.2;
var RUNNER_UP_MARGIN = 0.05;
function predictFiles(criteria, candidates, opts = {}) {
  const floor = opts.confidenceFloor ?? CONFIDENCE_FLOOR;
  const margin = opts.runnerUpMargin ?? RUNNER_UP_MARGIN;
  const scored = rank(criteria, candidates);
  const top = scored[0]?.score ?? 0;
  if (top <= 0) return [];
  if (top < floor) return [];
  const runnerUp = scored.find((m) => m.score < top)?.score ?? 0;
  if (top - runnerUp < margin) return [];
  return scored.filter((m) => m.score === top);
}

// src/config.ts
var DEFAULTS = {
  maxCommitFiles: 50,
  halfLifeDays: 180,
  minSupport: 2,
  minCommits: 200,
  hubZThreshold: 3,
  budgetTokens: 2e3,
  out: null,
  // Values live in lexical.ts, next to the calibration comment that justifies
  // them — a single spelling of each pinned number, read here rather than
  // re-typed.
  lexicalConfidenceFloor: CONFIDENCE_FLOOR,
  lexicalRunnerUpMargin: RUNNER_UP_MARGIN,
  // This tool's own working state, never the codebase under analysis — see
  // `isExcludedPath`'s doc comment (noise.ts) for the octoweb measurement
  // that justifies the default and `drift.ts` for why only `drift()` reads it.
  excludePaths: [
    // MOST OF THIS LIST IS INSURANCE, NOT ROUTINE.
    //
    // `harvest` reads `git log`, so only TRACKED files can enter the graph at
    // all: an ordinary `node_modules`, `.venv` or `target/` is gitignored and
    // excluded by the nature of the input, not by anything here. Measured on
    // two real repos, none of them appeared even once.
    //
    // They are listed anyway because a project that COMMITS them — a vendored
    // dependency tree, a checked-in virtualenv, build output kept for a
    // deploy — would otherwise have its graph flooded by someone else's code,
    // and would have to discover that by reading confusing output and then
    // enumerating directories by hand. Onboarding should not cost that.
    //
    // Applied at the graph's INPUT (`harvest`), so modules, clustering, hubs,
    // working sets, `impact` and `drift` all see one graph with one meaning.
    // A wrong entry therefore removes a path from the analysis entirely — one
    // line of `octograph.yaml` to undo, but not a cosmetic mistake.
    //
    // This lived in `drift` alone until 2026-08-12, so `impact` could still
    // surface an agent's notes co-changing with the code they document.
    // Measurement retired that: on a repo where the board was 43% of files,
    // including it doubled the file edges, took hub quarantine from 5 files to
    // 39, and mis-ranked 4 of the top 5 real module edges.
    // This tool's own working state and the board it edits. Measured at 32% of
    // octoweb's graph, burying every real cross-module finding beneath it.
    ".agents/",
    ".claude/",
    ".octobots/",
    // CI, editor and tool configuration: co-changes with whatever it
    // configures, which is nearly everything, and is not architecture.
    ".github/",
    ".vscode/",
    ".idea/",
    // Dependencies a project chose to commit — someone else's architecture.
    "node_modules/",
    "vendor/",
    "third_party/",
    // Python environments and caches.
    ".venv/",
    "venv/",
    "__pycache__/",
    ".tox/",
    ".mypy_cache/",
    ".pytest_cache/",
    // JVM / Rust / general build output kept in tree.
    "target/",
    ".gradle/",
    "dist/",
    "build/",
    "out/",
    "coverage/",
    // Framework build caches.
    ".next/",
    ".nuxt/",
    ".cache/"
  ]
};
var NUMERIC = [
  "maxCommitFiles",
  "halfLifeDays",
  "minSupport",
  "minCommits",
  "hubZThreshold",
  "budgetTokens",
  "lexicalConfidenceFloor",
  "lexicalRunnerUpMargin"
];
function loadConfig(repoRoot, overrides = {}) {
  const cfg = { ...DEFAULTS };
  const path = join4(repoRoot, "octograph.yaml");
  if (existsSync3(path)) {
    try {
      const doc = load(readFileSync3(path, "utf8"));
      if (doc !== null && typeof doc === "object" && !Array.isArray(doc)) {
        const parsed = doc;
        for (const key of NUMERIC) {
          const v = parsed[key];
          if (typeof v === "number" && Number.isFinite(v)) cfg[key] = v;
        }
        if (typeof parsed.out === "string" && insideRepo(repoRoot, parsed.out) !== null) {
          cfg.out = parsed.out;
        }
        if (Array.isArray(parsed.excludePaths) && parsed.excludePaths.every((v) => typeof v === "string")) {
          cfg.excludePaths = parsed.excludePaths;
        }
      }
    } catch {
    }
  }
  for (const key of Object.keys(DEFAULTS)) {
    const value = overrides[key];
    if (value !== void 0) Object.assign(cfg, { [key]: value });
  }
  return cfg;
}
function lexicalOptions(config) {
  return {
    confidenceFloor: config.lexicalConfidenceFloor,
    runnerUpMargin: config.lexicalRunnerUpMargin
  };
}
function historyIsThin(analysableCommits, config) {
  return analysableCommits < config.minCommits;
}

// src/analyze.ts
function analyze(repoRoot, config, opts) {
  const commits = harvest(repoRoot, {
    maxCommitFiles: config.maxCommitFiles,
    since: opts.since,
    excludePaths: config.excludePaths
  });
  const table = countPairs(commits, { now: opts.now, halfLifeDays: config.halfLifeDays });
  const edges = weighEdges(table, { minSupport: config.minSupport });
  const hubIds = detectHubs(edges, table.files.length, { zThreshold: config.hubZThreshold });
  const testIds = /* @__PURE__ */ new Set();
  table.files.forEach((path, id) => {
    if (isTestPath(path)) testIds.add(id);
  });
  const clusterable = edges.filter(
    (e) => !hubIds.has(e.a) && !hubIds.has(e.b) && !testIds.has(e.a) && !testIds.has(e.b)
  );
  const bridgedEdges = bridgeComponents(clusterable, table.files);
  const synthetic = bridgedEdges.length - clusterable.length;
  const partition = louvain(bridgedEdges, { exclude: /* @__PURE__ */ new Set([...hubIds, ...testIds]) });
  const byCommunity = /* @__PURE__ */ new Map();
  for (const [node, comm] of partition) {
    const list = byCommunity.get(comm);
    if (list) list.push(node);
    else byCommunity.set(comm, [node]);
  }
  const spine = declaredSpine(repoRoot, table.files);
  const workingSetList = historyIsThin(commits.length, config) ? [] : workingSets(byCommunity, bridgedEdges, table.files, spine.moduleOf);
  const moduleEdgesDirected = spine.imports.length > 0;
  const moduleEdges = moduleEdgesDirected ? spine.imports : rollUp(edges, table.files, spine.moduleOf);
  const ranks = layerRanks(spine.modules, spine.imports);
  const homeOf = /* @__PURE__ */ new Map();
  const unvoted = [];
  for (const hub of [...hubIds].sort((x, y) => x - y)) {
    const votes = /* @__PURE__ */ new Map();
    for (const e of edges) {
      const other = e.a === hub ? e.b : e.b === hub ? e.a : -1;
      if (other === -1 || hubIds.has(other)) continue;
      const comm = partition.get(other);
      if (comm === void 0) continue;
      votes.set(comm, (votes.get(comm) ?? 0) + edgeWeight(e));
    }
    let best = -1;
    let bestWeight = -1;
    for (const [comm, w] of [...votes].sort((x, y) => x[0] - y[0])) {
      if (w > bestWeight) {
        best = comm;
        bestWeight = w;
      }
    }
    if (best === -1) unvoted.push(hub);
    else homeOf.set(hub, best);
  }
  const pathsOf = (ids) => ids.map((n) => table.files[n]).filter((p) => p !== void 0).sort();
  const merged = /* @__PURE__ */ new Map();
  for (const [comm, members] of [...byCommunity.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0] - b[0]
  )) {
    const primary = nameCluster(members, bridgedEdges, table.files, 1)[0];
    const name = primary === void 0 ? `cluster-${comm}` : spine.moduleOf(primary);
    const attached = [...members];
    for (const [hub, home] of homeOf) if (home === comm) attached.push(hub);
    const existing = merged.get(name);
    if (existing) existing.push(...attached);
    else merged.set(name, attached);
  }
  for (const hub of unvoted) {
    const path = table.files[hub];
    if (path === void 0) continue;
    const name = spine.moduleOf(path);
    const existing = merged.get(name);
    if (existing) existing.push(hub);
    else merged.set(name, [hub]);
  }
  const homeOfId = /* @__PURE__ */ new Map();
  for (const [name, ids] of merged) for (const id of ids) homeOfId.set(id, name);
  const declaredMembers = filesByModule(table.files, spine.moduleOf);
  for (const [name, ids] of declaredMembers) {
    if (merged.has(name)) continue;
    for (const id of ids) {
      const oldName = homeOfId.get(id);
      if (oldName === void 0) continue;
      const bucket = merged.get(oldName);
      if (bucket === void 0) continue;
      const idx = bucket.indexOf(id);
      if (idx !== -1) bucket.splice(idx, 1);
    }
    merged.set(name, ids);
  }
  for (const [name, ids] of [...merged]) if (ids.length === 0) merged.delete(name);
  for (const name of spine.modules) if (!merged.has(name)) merged.set(name, []);
  const preliminary = [...merged.entries()].sort((a, b) => b[1].length - a[1].length || compare(a[0], b[0])).map(([name], i) => ({
    id: i,
    name,
    members: pathsOf(declaredMembers.get(name) ?? []),
    layer: ranks?.get(name) ?? null
  }));
  const previousClusters = opts.previousClusters ?? /* @__PURE__ */ new Map();
  const freshClusters = new Map(preliminary.map((m) => [m.id, m.members]));
  const remap = remapClusters(previousClusters, freshClusters);
  let kept = 0;
  let fresh = 0;
  const modules = preliminary.map((m) => {
    const stableId = remap.get(m.id) ?? m.id;
    if (previousClusters.has(stableId)) kept++;
    else fresh++;
    return { ...m, id: stableId };
  });
  return {
    analysis: {
      commitCount: commits.length,
      fileCount: table.files.length,
      spineSource: spine.source,
      modules,
      moduleEdges,
      moduleEdgesDirected,
      hubs: pathsOf([...hubIds]),
      bridged: synthetic,
      clusterIds: { kept, fresh },
      workingSets: workingSetList
    },
    edges,
    files: table.files,
    spine
  };
}

// src/artifact.ts
import { existsSync as existsSync4, mkdirSync, readFileSync as readFileSync4, writeFileSync } from "node:fs";
import { join as join5, resolve as resolve2 } from "node:path";
function hasBoard(repoRoot) {
  return existsSync4(join5(repoRoot, ".octobots"));
}
function boardDir(repoRoot) {
  return hasBoard(repoRoot) ? join5(repoRoot, ".octobots") : null;
}
function resolveOut(repoRoot, config) {
  if (config.out && insideRepo(repoRoot, config.out) !== null) {
    return resolve2(repoRoot, config.out);
  }
  if (hasBoard(repoRoot)) return join5(repoRoot, ".octobots", "graph");
  return join5(repoRoot, ".octograph");
}
function readArtifact(dir) {
  const path = join5(dir, "clusters.json");
  if (!existsSync4(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync4(path, "utf8"));
    return isStoredGraph(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
var CLUSTER_KEY = /^(0|[1-9][0-9]*)$/;
function isStoredGraph(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const doc = value;
  if (doc.version !== 1) return false;
  const clusters = doc.clusters;
  if (clusters === null || typeof clusters !== "object" || Array.isArray(clusters)) return false;
  for (const [id, members] of Object.entries(clusters)) {
    if (!CLUSTER_KEY.test(id)) return false;
    if (!Array.isArray(members)) return false;
    if (members.some((m) => typeof m !== "string")) return false;
  }
  return true;
}
function writeArtifact(dir, graph) {
  mkdirSync(dir, { recursive: true });
  const ordered = {};
  for (const key of Object.keys(graph.clusters).map(Number).sort((a, b) => a - b)) {
    ordered[key] = [...graph.clusters[key] ?? []].sort(compare);
  }
  const payload = withSortedKeys({
    ...graph,
    clusters: ordered,
    config: withSortedKeys(graph.config)
  });
  writeFileSync(join5(dir, "clusters.json"), JSON.stringify(payload, null, 2) + "\n");
}
function withSortedKeys(record) {
  const source = record;
  const out = {};
  for (const key of Object.keys(source).sort(compare)) out[key] = source[key];
  return out;
}

// ../board/dist/managed-block.js
var PLACEHOLDER = "_(not set)_";
function mapBoardStatus(raw) {
  const key = raw.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  switch (key) {
    case "draft":
      return "draft";
    case "active":
    case "executing":
    case "in progress":
    case "running":
      return "executing";
    case "awaiting approval":
    case "awaitingapproval":
    case "awaiting":
      return "awaitingApproval";
    case "done":
    case "complete":
    case "completed":
      return "done";
    case "failed":
    case "fail":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return null;
  }
}
function parseManagedBlock(text) {
  const heading = /^#\s+(.+?)\s*$/m.exec(text);
  const name = heading ? (heading[1] ?? "").trim() : "";
  const idMarker = /^<!--\s*octobots:id\s+(\S+)\s*-->/m.exec(text);
  const id = idMarker ? idMarker[1] : void 0;
  const sectionBody = (label) => {
    const re = new RegExp(`^##\\s+${label}\\s*$`, "m");
    const mt = re.exec(text);
    if (!mt)
      return "";
    const rest = text.slice(mt.index + mt[0].length);
    const nextHeading = rest.search(/^##\s+/m);
    const comment = rest.search(/^<!--/m);
    const ends = [nextHeading, comment].filter((n) => n >= 0);
    const cut = ends.length ? Math.min(...ends) : -1;
    const body = (cut >= 0 ? rest.slice(0, cut) : rest).trim();
    return body === PLACEHOLDER ? "" : body;
  };
  return {
    ...id ? { id } : {},
    name,
    description: sectionBody("Description"),
    acceptanceCriteria: sectionBody("Acceptance Criteria"),
    target: sectionBody("Target"),
    status: sectionBody("Status"),
    severity: sectionBody("Severity"),
    stepsToReproduce: sectionBody("Steps to Reproduce"),
    expected: sectionBody("Expected"),
    actual: sectionBody("Actual"),
    rca: sectionBody("RCA"),
    environment: sectionBody("Environment"),
    runs: sectionBody("Runs")
  };
}
function boardLineEntityName(bareTitle) {
  const cleaned = bareTitle.replace(/^\[[ xX]\]\s*/, "").replace(/\*\*/g, "").trim();
  const sep2 = cleaned.match(/\s+[—–]\s+|:\s+/);
  return sep2 ? cleaned.slice(0, sep2.index).trim() : cleaned;
}

// ../board/dist/entity-schema.js
var ENTITY_STATUSES = ["draft", "executing", "awaitingApproval", "done", "failed", "cancelled"];
var KNOWN_KEYS = /* @__PURE__ */ new Set([
  "name",
  "description",
  "acceptance_criteria",
  "documents",
  "status",
  "role",
  "target",
  "severity",
  "steps_to_reproduce",
  "expected",
  "actual",
  "rca",
  "environment",
  "tokenomics",
  "notes"
]);
function asString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function optString(v) {
  return typeof v === "string" && v.length ? v : void 0;
}
function restOf(item, owned) {
  const rest = {};
  for (const [k, v] of Object.entries(item)) {
    if (!owned.includes(k))
      rest[k] = v;
  }
  return rest;
}
function isEmptyish(v) {
  if (v === null || v === void 0)
    return true;
  if (typeof v === "string")
    return v.trim() === "";
  if (Array.isArray(v))
    return v.length === 0;
  if (typeof v === "object")
    return Object.keys(v).length === 0;
  return false;
}
function carryForward(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!KNOWN_KEYS.has(k) || !isEmptyish(v))
      out[k] = v;
  }
  return out;
}
function parseCriteria(v) {
  if (!Array.isArray(v))
    return [];
  const out = [];
  for (const item of v) {
    if (item && typeof item === "object" && "text" in item) {
      out.push({
        text: asString(item.text),
        done: Boolean(item.done),
        ...restOf(item, ["text", "done"])
      });
    }
  }
  return out;
}
function parseDocuments(v) {
  if (!Array.isArray(v))
    return [];
  const out = [];
  for (const item of v) {
    if (item && typeof item === "object" && "target" in item) {
      const target = asString(item.target);
      if (target) {
        out.push({
          label: asString(item.label) || target,
          target,
          ...restOf(item, ["label", "target"])
        });
      }
    }
  }
  return out;
}
function parseTokenomics(v) {
  if (!v || typeof v !== "object" || Array.isArray(v))
    return void 0;
  const out = { ...v };
  return Object.keys(out).length ? out : void 0;
}
function loadEntity(text) {
  const raw = load(text) ?? {};
  return {
    name: asString(raw.name),
    description: asString(raw.description),
    acceptanceCriteria: parseCriteria(raw.acceptance_criteria),
    documents: parseDocuments(raw.documents),
    status: optString(raw.status),
    role: optString(raw.role),
    target: optString(raw.target),
    severity: optString(raw.severity),
    stepsToReproduce: optString(raw.steps_to_reproduce),
    expected: optString(raw.expected),
    actual: optString(raw.actual),
    rca: optString(raw.rca),
    environment: optString(raw.environment),
    tokenomics: parseTokenomics(raw.tokenomics),
    notes: optString(raw.notes),
    extra: carryForward(raw)
  };
}

// ../board/dist/workflow-meta.js
import { runInNewContext } from "node:vm";
function skipString(source, i) {
  const quote = source[i];
  for (let j = i + 1; j < source.length; j++) {
    const ch = source[j];
    if (ch === "\\") {
      j++;
      continue;
    }
    if (ch === quote)
      return j;
  }
  return source.length;
}
function findMetaSpan(source) {
  const decl = /export\s+const\s+meta\s*=\s*/.exec(source);
  if (!decl)
    return null;
  const open = source.indexOf("{", decl.index + decl[0].length);
  if (open < 0)
    return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(source, i);
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      if (nl < 0)
        return null;
      i = nl;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      if (close < 0)
        return null;
      i = close + 1;
      continue;
    }
    if (ch === "{")
      depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0)
        return { literal: source.slice(open, i + 1), start: open, end: i + 1 };
    }
  }
  return null;
}
function asString2(value) {
  return typeof value === "string" ? value : void 0;
}
function coerceStep(raw, phaseIndex, stepIndex) {
  const where = `meta.phases[${phaseIndex}].steps[${stepIndex}]`;
  if (typeof raw !== "object" || raw === null)
    throw new Error(`${where} is not an object`);
  const o = raw;
  const id = asString2(o["id"]);
  if (!id)
    throw new Error(`${where}.id is missing`);
  const agent = asString2(o["agent"]);
  if (!agent)
    throw new Error(`${where}.agent is missing`);
  const label = asString2(o["label"]);
  if (!label)
    throw new Error(`${where}.label is missing`);
  const step = { id, agent, label };
  const parallel = asString2(o["parallel"]);
  if (parallel)
    step.parallel = parallel;
  const backend = asString2(o["backend"]);
  if (backend)
    step.backend = backend;
  const dependsOn = o["dependsOn"];
  if (Array.isArray(dependsOn)) {
    const ids = dependsOn.filter((d) => typeof d === "string");
    if (ids.length)
      step.dependsOn = ids;
  }
  return step;
}
function coercePhase(raw, phaseIndex) {
  const where = `meta.phases[${phaseIndex}]`;
  if (typeof raw !== "object" || raw === null)
    throw new Error(`${where} is not an object`);
  const o = raw;
  const title = asString2(o["title"]);
  if (!title)
    throw new Error(`${where}.title is missing`);
  const rawSteps = o["steps"];
  const steps = Array.isArray(rawSteps) ? rawSteps.map((s, j) => coerceStep(s, phaseIndex, j)) : [];
  const phase = { title, steps };
  const detail = asString2(o["detail"]);
  if (detail)
    phase.detail = detail;
  return phase;
}
function parseWorkflowMeta(source) {
  const span = findMetaSpan(source);
  if (!span)
    throw new Error("no `export const meta` object literal found in workflow.js");
  let raw;
  try {
    raw = runInNewContext(`(${span.literal})`, /* @__PURE__ */ Object.create(null), { timeout: 50 });
  } catch (err) {
    throw new Error(`meta is not a pure object literal: ${err.message}`);
  }
  if (typeof raw !== "object" || raw === null)
    throw new Error("meta is not an object");
  const o = raw;
  const name = asString2(o["name"]);
  if (!name)
    throw new Error("meta.name is missing");
  const rawPhases = o["phases"];
  const phases = Array.isArray(rawPhases) ? rawPhases.map((p, i) => coercePhase(p, i)) : [];
  return { name, description: asString2(o["description"]) ?? "", phases };
}

// ../board/dist/board-model.js
import { readdirSync as readdirSync2, readFileSync as readFileSync5, statSync as statSync2 } from "node:fs";
import { join as join6 } from "node:path";
var BoardModel = class {
  root;
  // Entity maps keyed by id
  campaigns = /* @__PURE__ */ new Map();
  missions = /* @__PURE__ */ new Map();
  tasks = /* @__PURE__ */ new Map();
  bugs = /* @__PURE__ */ new Map();
  workflows = /* @__PURE__ */ new Map();
  // Parent-indexed lists
  missionsByCampaign = /* @__PURE__ */ new Map();
  // campaignId → mission ids
  tasksByMission = /* @__PURE__ */ new Map();
  // missionId → task ids
  bugsByCampaign = /* @__PURE__ */ new Map();
  // campaignId → bug ids
  bugsByMission = /* @__PURE__ */ new Map();
  // missionId → bug ids
  workflowsByCampaign = /* @__PURE__ */ new Map();
  // campaignId → workflow ids
  workflowsByMission = /* @__PURE__ */ new Map();
  // missionId → workflow ids
  // FolderPath → id indexes
  campaignByFolder = /* @__PURE__ */ new Map();
  missionByFolder = /* @__PURE__ */ new Map();
  taskByFolder = /* @__PURE__ */ new Map();
  bugByFolder = /* @__PURE__ */ new Map();
  workflowByFolder = /* @__PURE__ */ new Map();
  // Files without an id marker
  missingIds = [];
  constructor(artifactsRoot) {
    this.root = artifactsRoot;
  }
  /** Re-parse the entire disk tree. All internal state is reset first. */
  rebuild() {
    this.campaigns.clear();
    this.missions.clear();
    this.tasks.clear();
    this.bugs.clear();
    this.workflows.clear();
    this.missionsByCampaign.clear();
    this.tasksByMission.clear();
    this.bugsByCampaign.clear();
    this.bugsByMission.clear();
    this.workflowsByCampaign.clear();
    this.workflowsByMission.clear();
    this.campaignByFolder.clear();
    this.missionByFolder.clear();
    this.taskByFolder.clear();
    this.bugByFolder.clear();
    this.workflowByFolder.clear();
    this.missingIds = [];
    if (!this.root)
      return;
    const campaignsDir = join6(this.root, "campaigns");
    const cSlugs = safeReaddir(campaignsDir);
    for (const cslug of cSlugs) {
      const cFolder = `campaigns/${cslug}`;
      const cRead = readEntity(this.root, cFolder, "campaign");
      if (!cRead)
        continue;
      const cf = cRead.fields;
      const cMtime = cRead.mtime;
      const cId = cf.id ?? `folder:${cFolder}`;
      if (!cRead.isYaml && !cf.id)
        this.missingIds.push({ kind: "campaign", folderPath: cFolder, mdPath: cRead.mdPath });
      const campaign = {
        id: cId,
        name: cf.name || deSlug(cslug),
        isDefault: false,
        description: cf.description,
        acceptanceCriteria: cf.acceptanceCriteria,
        target: cf.target ?? "",
        status: resolveStatus(cf.ownStatus),
        ...cf.notes ? { notes: cf.notes } : {},
        folderPath: cFolder,
        createdAt: cMtime,
        updatedAt: cMtime
      };
      this.campaigns.set(cId, campaign);
      this.campaignByFolder.set(cFolder, cId);
      this.missionsByCampaign.set(cId, []);
      this.bugsByCampaign.set(cId, []);
      this.workflowsByCampaign.set(cId, []);
      for (const wf of parseWorkflows(this.root, cFolder, { campaignId: cId })) {
        this.workflows.set(wf.id, wf);
        this.workflowByFolder.set(wf.folderPath, wf.id);
        this.workflowsByCampaign.get(cId).push(wf.id);
      }
      const cText = cRead.isYaml ? "" : safeReadFile(join6(this.root, cFolder, "campaign.md")) ?? "";
      const cBugStatuses = parseSectionBoardStatuses(cText, "## Bugs");
      const cMissionStatuses = parseSectionBoardStatuses(cText, "## Missions");
      const cBugsDir = join6(this.root, cFolder, "bugs");
      const bSlugs = safeReaddir(cBugsDir);
      for (const bslug of bSlugs) {
        const bFolder = `${cFolder}/bugs/${bslug}`;
        const bRead = readEntity(this.root, bFolder, "bug");
        if (!bRead)
          continue;
        const bf = bRead.fields;
        const bId = bf.id ?? `folder:${bFolder}`;
        if (!bRead.isYaml && !bf.id)
          this.missingIds.push({ kind: "bug", folderPath: bFolder, mdPath: bRead.mdPath });
        const bugTitle = boardLineEntityName(bf.name || deSlug(bslug)).toLowerCase();
        const bug = {
          id: bId,
          campaignId: cId,
          missionId: null,
          title: bf.name || deSlug(bslug),
          status: bf.ownStatus ?? cBugStatuses.get(bugTitle) ?? "draft",
          severity: parseSeverity(bf.severity),
          description: bf.description,
          stepsToReproduce: bf.stepsToReproduce ?? "",
          expected: bf.expected ?? "",
          actual: bf.actual ?? "",
          rca: bf.rca ?? "",
          environment: bf.environment ?? "",
          ...bf.notes ? { notes: bf.notes } : {},
          folderPath: bFolder,
          createdAt: bRead.mtime,
          updatedAt: bRead.mtime
        };
        this.bugs.set(bId, bug);
        this.bugByFolder.set(bFolder, bId);
        this.bugsByCampaign.get(cId).push(bId);
      }
      const missionsDir = join6(this.root, cFolder, "missions");
      const mSlugs = safeReaddir(missionsDir);
      for (const mslug of mSlugs) {
        const mFolder = `${cFolder}/missions/${mslug}`;
        const mRead = readEntity(this.root, mFolder, "mission");
        if (!mRead)
          continue;
        const mf = mRead.fields;
        const mId = mf.id ?? `folder:${mFolder}`;
        if (!mRead.isYaml && !mf.id)
          this.missingIds.push({ kind: "mission", folderPath: mFolder, mdPath: mRead.mdPath });
        const mission = {
          id: mId,
          campaignId: cId,
          title: mf.name || deSlug(mslug),
          status: mf.ownStatus ?? cMissionStatuses.get(boardLineEntityName(mf.name || deSlug(mslug)).toLowerCase()) ?? "draft",
          description: mf.description,
          acceptanceCriteria: mf.acceptanceCriteria,
          ...mf.tokenomics ? { tokenomics: mf.tokenomics } : {},
          ...mf.notes ? { notes: mf.notes } : {},
          folderPath: mFolder,
          createdAt: mRead.mtime,
          updatedAt: mRead.mtime
        };
        this.missions.set(mId, mission);
        this.missionByFolder.set(mFolder, mId);
        this.missionsByCampaign.get(cId).push(mId);
        this.tasksByMission.set(mId, []);
        this.bugsByMission.set(mId, []);
        this.workflowsByMission.set(mId, []);
        for (const wf of parseWorkflows(this.root, mFolder, { missionId: mId })) {
          this.workflows.set(wf.id, wf);
          this.workflowByFolder.set(wf.folderPath, wf.id);
          this.workflowsByMission.get(mId).push(wf.id);
        }
        const mText = mRead.isYaml ? "" : safeReadFile(join6(this.root, mFolder, "mission.md")) ?? "";
        const mBugStatuses = parseSectionBoardStatuses(mText, "## Bugs");
        const mTaskStatuses = parseSectionBoardStatuses(mText, "## Tasks");
        const mBugsDir = join6(this.root, mFolder, "bugs");
        const mbSlugs = safeReaddir(mBugsDir);
        for (const bslug of mbSlugs) {
          const bFolder = `${mFolder}/bugs/${bslug}`;
          const bRead = readEntity(this.root, bFolder, "bug");
          if (!bRead)
            continue;
          const bf = bRead.fields;
          const bId = bf.id ?? `folder:${bFolder}`;
          if (!bRead.isYaml && !bf.id)
            this.missingIds.push({ kind: "bug", folderPath: bFolder, mdPath: bRead.mdPath });
          const bugTitle = boardLineEntityName(bf.name || deSlug(bslug)).toLowerCase();
          const bug = {
            id: bId,
            campaignId: null,
            missionId: mId,
            title: bf.name || deSlug(bslug),
            status: bf.ownStatus ?? mBugStatuses.get(bugTitle) ?? "draft",
            severity: parseSeverity(bf.severity),
            description: bf.description,
            stepsToReproduce: bf.stepsToReproduce ?? "",
            expected: bf.expected ?? "",
            actual: bf.actual ?? "",
            rca: bf.rca ?? "",
            environment: bf.environment ?? "",
            folderPath: bFolder,
            createdAt: bRead.mtime,
            updatedAt: bRead.mtime
          };
          this.bugs.set(bId, bug);
          this.bugByFolder.set(bFolder, bId);
          this.bugsByMission.get(mId).push(bId);
        }
        const tasksDir = join6(this.root, mFolder, "tasks");
        const tSlugs = safeReaddir(tasksDir);
        for (const tslug of tSlugs) {
          const tFolder = `${mFolder}/tasks/${tslug}`;
          const tRead = readEntity(this.root, tFolder, "task");
          if (!tRead)
            continue;
          const tf = tRead.fields;
          const tId = tf.id ?? `folder:${tFolder}`;
          if (!tRead.isYaml && !tf.id)
            this.missingIds.push({ kind: "task", folderPath: tFolder, mdPath: tRead.mdPath });
          const taskName = boardLineEntityName(tf.name || deSlug(tslug)).toLowerCase();
          const task = {
            id: tId,
            missionId: mId,
            name: tf.name || deSlug(tslug),
            status: tf.ownStatus ?? mTaskStatuses.get(taskName) ?? "draft",
            description: tf.description,
            acceptanceCriteria: tf.acceptanceCriteria,
            ...tf.tokenomics ? { tokenomics: tf.tokenomics } : {},
            ...tf.notes ? { notes: tf.notes } : {},
            folderPath: tFolder,
            createdAt: tRead.mtime,
            updatedAt: tRead.mtime
          };
          this.tasks.set(tId, task);
          this.taskByFolder.set(tFolder, tId);
          this.tasksByMission.get(mId).push(tId);
        }
      }
    }
  }
  // ── Read API ────────────────────────────────────────────────────────────────
  /** All campaigns, sorted newest-first by createdAt then folderPath (mirrors `created_at DESC, rowid DESC`). */
  listCampaigns() {
    return sortEntities([...this.campaigns.values()]);
  }
  getCampaign(id) {
    return this.campaigns.get(id) ?? null;
  }
  /** Missions for a campaign, sorted newest-first. */
  listMissions(campaignId) {
    const ids = this.missionsByCampaign.get(campaignId) ?? [];
    const entities = ids.map((id) => this.missions.get(id)).filter((m) => m !== void 0);
    return sortEntities(entities);
  }
  getMission(id) {
    return this.missions.get(id) ?? null;
  }
  /** Tasks for a mission, sorted newest-first. */
  listTasks(missionId) {
    const ids = this.tasksByMission.get(missionId) ?? [];
    const entities = ids.map((id) => this.tasks.get(id)).filter((t) => t !== void 0);
    return sortEntities(entities);
  }
  getTask(id) {
    return this.tasks.get(id) ?? null;
  }
  /** Bugs for a campaign or mission parent. */
  listBugs(parent) {
    let ids;
    if ("campaignId" in parent) {
      ids = this.bugsByCampaign.get(parent.campaignId) ?? [];
    } else {
      ids = this.bugsByMission.get(parent.missionId) ?? [];
    }
    const entities = ids.map((id) => this.bugs.get(id)).filter((b) => b !== void 0);
    return sortEntities(entities);
  }
  getBug(id) {
    return this.bugs.get(id) ?? null;
  }
  /** Workflows for a campaign or mission parent, sorted newest-first. */
  listWorkflows(parent) {
    const ids = "campaignId" in parent ? this.workflowsByCampaign.get(parent.campaignId) ?? [] : this.workflowsByMission.get(parent.missionId) ?? [];
    const entities = ids.map((id) => this.workflows.get(id)).filter((w) => w !== void 0);
    return sortEntities(entities);
  }
  getWorkflow(id) {
    return this.workflows.get(id) ?? null;
  }
  // ── FolderPath → id indexes ──────────────────────────────────────────────
  campaignIdByFolderPath(folderPath) {
    return this.campaignByFolder.get(folderPath) ?? null;
  }
  missionIdByFolderPath(folderPath) {
    return this.missionByFolder.get(folderPath) ?? null;
  }
  taskIdByFolderPath(folderPath) {
    return this.taskByFolder.get(folderPath) ?? null;
  }
  bugIdByFolderPath(folderPath) {
    return this.bugByFolder.get(folderPath) ?? null;
  }
  workflowIdByFolderPath(folderPath) {
    return this.workflowByFolder.get(folderPath) ?? null;
  }
  // ── Missing ID tracking ──────────────────────────────────────────────────
  /** Returns all parsed .md files that had no `<!-- octobots:id ... -->` marker. */
  missingIdFiles() {
    return [...this.missingIds];
  }
};
function parseSectionBoardStatuses(text, sectionHeading) {
  const result = /* @__PURE__ */ new Map();
  try {
    const boundaryIdx = text.indexOf("<!-- Auto-generated by Octobots");
    const scanText = boundaryIdx >= 0 ? text.slice(boundaryIdx) : text;
    const headingRe = new RegExp(`^${sectionHeading}\\s*$`, "m");
    const headMatch = headingRe.exec(scanText);
    if (!headMatch)
      return result;
    const afterHeading = scanText.slice(headMatch.index + headMatch[0].length);
    const nextHeadingIdx = afterHeading.search(/^##\s+/m);
    const sectionText = nextHeadingIdx >= 0 ? afterHeading.slice(0, nextHeadingIdx) : afterHeading;
    for (const line of sectionText.split("\n")) {
      const bullet = line.match(/^[-*]\s+(.*)$/) ?? line.match(/^\d+[.)]\s+(.*)/);
      if (!bullet)
        continue;
      const body = bullet[1] ?? "";
      let rest = body;
      let statusValue;
      for (; ; ) {
        const m = rest.match(/^\[([a-z]+):([^\]]*)\]\s*/i);
        if (!m)
          break;
        if ((m[1] ?? "").toLowerCase() === "status") {
          statusValue = (m[2] ?? "").trim();
        }
        rest = rest.slice(m[0].length);
      }
      const bareTitle = boardLineEntityName(rest).toLowerCase();
      if (!bareTitle)
        continue;
      if (statusValue !== void 0) {
        const mapped = mapBoardStatus(statusValue);
        if (mapped !== null) {
          result.set(bareTitle, mapped);
        }
      }
    }
  } catch {
  }
  return result;
}
function parseWorkflows(root, parentFolder, parent) {
  const out = [];
  const dir = join6(root, parentFolder, "workflows");
  for (const slug of safeReaddir(dir)) {
    const folderPath = `${parentFolder}/workflows/${slug}`;
    const jsPath = join6(root, folderPath, "workflow.js");
    const jsText = safeReadFile(jsPath);
    if (jsText === null)
      continue;
    let name = deSlug(slug);
    let description = "";
    let phases = [];
    let parseError = null;
    try {
      const meta = parseWorkflowMeta(jsText);
      name = meta.name;
      if (meta.description)
        description = meta.description;
      phases = meta.phases;
    } catch (err) {
      parseError = err.message;
    }
    const mtime = safeMtime(jsPath);
    out.push({
      id: `folder:${folderPath}`,
      campaignId: "campaignId" in parent ? parent.campaignId : null,
      missionId: "missionId" in parent ? parent.missionId : null,
      name,
      description,
      phases,
      scriptPath: `${folderPath}/workflow.js`,
      folderPath,
      parseError,
      lastRunStatus: readLastRunStatus(root, folderPath),
      createdAt: mtime,
      updatedAt: mtime
    });
  }
  return out;
}
function readLastRunStatus(root, folderPath) {
  const jsonl = safeReadFile(join6(root, folderPath, "runs.jsonl"));
  if (jsonl !== null)
    return newestRunStatusFromJsonl(jsonl);
  const md = safeReadFile(join6(root, folderPath, "workflow.md"));
  if (md !== null)
    return newestRunStatus(parseManagedBlock(md).runs ?? "");
  return null;
}
function newestRunStatusFromJsonl(body) {
  let last = null;
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t)
      continue;
    try {
      const status = JSON.parse(t).status;
      const mapped = mapBoardStatus(String(status ?? "").trim());
      if (mapped)
        last = mapped;
    } catch {
    }
  }
  return last;
}
function newestRunStatus(runsBody) {
  let last = null;
  for (const line of runsBody.split("\n")) {
    const m = line.match(/^\s*-\s*\[status:([^\]]+)\]/i);
    if (!m)
      continue;
    const mapped = mapBoardStatus((m[1] ?? "").trim());
    if (mapped)
      last = mapped;
  }
  return last;
}
function safeReaddir(dir) {
  try {
    return readdirSync2(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
function safeReadFile(path) {
  try {
    return readFileSync5(path, "utf8");
  } catch {
    return null;
  }
}
function safeMtime(path) {
  try {
    return statSync2(path).mtimeMs;
  } catch {
    return Date.now();
  }
}
function renderCriteria(cs) {
  return cs.map((c) => `- [${c.done ? "x" : " "}] ${c.text}`).join("\n");
}
function resolveStatus(raw) {
  if (!raw)
    return "draft";
  if (ENTITY_STATUSES.includes(raw))
    return raw;
  return mapBoardStatus(raw) ?? "draft";
}
function readEntity(root, folderPath, kind) {
  const yamlPath = join6(root, folderPath, `${kind}.yaml`);
  const mdPath = join6(root, folderPath, `${kind}.md`);
  const yText = safeReadFile(yamlPath);
  if (yText !== null) {
    const f = loadEntity(yText);
    return {
      mtime: safeMtime(yamlPath),
      isYaml: true,
      mdPath,
      fields: {
        name: f.name,
        description: f.description,
        acceptanceCriteria: renderCriteria(f.acceptanceCriteria),
        ownStatus: resolveStatus(f.status),
        role: f.role,
        target: f.target,
        severity: f.severity,
        stepsToReproduce: f.stepsToReproduce,
        expected: f.expected,
        actual: f.actual,
        rca: f.rca,
        environment: f.environment,
        tokenomics: f.tokenomics,
        notes: f.notes
      }
    };
  }
  const mText = safeReadFile(mdPath);
  if (mText === null)
    return null;
  const mf = parseManagedBlock(mText);
  return {
    mtime: safeMtime(mdPath),
    isYaml: false,
    mdPath,
    fields: {
      id: mf.id,
      name: mf.name,
      description: mf.description ?? "",
      acceptanceCriteria: mf.acceptanceCriteria ?? "",
      ownStatus: kind === "campaign" ? resolveStatus(mf.status) : void 0,
      target: mf.target,
      severity: mf.severity,
      stepsToReproduce: mf.stepsToReproduce,
      expected: mf.expected,
      actual: mf.actual,
      rca: mf.rca,
      environment: mf.environment
    }
  };
}
function deSlug(slug) {
  return slug.replace(/-+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function parseSeverity(raw) {
  const valid = ["blocker", "critical", "major", "minor", "trivial"];
  const s = (raw ?? "").trim().toLowerCase();
  return valid.includes(s) ? s : "major";
}
function sortEntities(entities) {
  return entities.slice().sort((a, b) => {
    const dtMs = b.createdAt - a.createdAt;
    if (dtMs !== 0)
      return dtMs;
    return a.folderPath < b.folderPath ? -1 : a.folderPath > b.folderPath ? 1 : 0;
  });
}

// ../board/dist/write.js
function parseCriteriaString(s) {
  const out = [];
  for (const line of (s ?? "").split("\n")) {
    const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
    if (m)
      out.push({ text: (m[2] ?? "").trim(), done: (m[1] ?? " ").toLowerCase() === "x" });
  }
  return out;
}

// src/board.ts
function readCriteria(rendered) {
  return parseCriteriaString(rendered).map((c) => c.text);
}
function readBoard(repoRoot) {
  const root = boardDir(repoRoot);
  if (root === null) return null;
  const model = new BoardModel(root);
  model.rebuild();
  const tasks = [];
  const missionOfTask = /* @__PURE__ */ new Map();
  const missionNameOfTask = /* @__PURE__ */ new Map();
  for (const campaign of model.listCampaigns()) {
    for (const mission of model.listMissions(campaign.id)) {
      for (const task of model.listTasks(mission.id)) {
        tasks.push({
          id: task.id,
          name: task.name,
          mission: mission.id,
          campaign: campaign.id,
          criteria: readCriteria(task.acceptanceCriteria)
        });
        missionOfTask.set(task.id, mission.id);
        missionNameOfTask.set(task.id, mission.title);
      }
    }
  }
  tasks.sort(
    (a, b) => compare(a.campaign, b.campaign) || compare(a.mission, b.mission) || compare(a.id, b.id)
  );
  return {
    tasks,
    missionOf: (taskId) => missionOfTask.get(taskId) ?? null,
    missionNameOf: (taskId) => missionNameOfTask.get(taskId) ?? null
  };
}

// src/conflicts.ts
function moduleOfFile(analysis) {
  const map = /* @__PURE__ */ new Map();
  for (const m of analysis.modules) for (const f of m.members) map.set(f, m.name);
  return map;
}
function surfaceFor(task, candidates, modOf, lexical) {
  const files = predictFiles(task.criteria, candidates, lexical).map((m) => m.file).sort(compare);
  const modules = /* @__PURE__ */ new Set();
  for (const f of files) {
    const m = modOf.get(f);
    if (m !== void 0) modules.add(m);
  }
  return { task, files, modules };
}
function isNoiseOnItsOwn(file, corpus) {
  if (classifyPair(file, file) !== "candidate") return true;
  for (const other of corpus) {
    if (other === file) continue;
    if (classifyPair(file, other) === "mechanical") return true;
  }
  return false;
}
function buildEdgeIndex(edges) {
  const index = /* @__PURE__ */ new Map();
  for (const e of edges) {
    if (isSyntheticBridge(e)) continue;
    const lo = Math.min(e.a, e.b);
    const hi = Math.max(e.a, e.b);
    let row = index.get(lo);
    if (!row) index.set(lo, row = /* @__PURE__ */ new Map());
    row.set(hi, e);
  }
  return index;
}
function edgeBetween(index, i, j) {
  const lo = Math.min(i, j);
  const hi = Math.max(i, j);
  return index.get(lo)?.get(hi);
}
function coupledScore(surfaceA, surfaceB, idOf, edgeIndex, isNoise) {
  const seen = /* @__PURE__ */ new Set();
  let sum = 0;
  for (const fa of surfaceA) {
    if (isNoise(fa)) continue;
    for (const fb of surfaceB) {
      if (fa === fb) continue;
      if (isNoise(fb)) continue;
      const ia = idOf.get(fa);
      const ib = idOf.get(fb);
      if (ia === void 0 || ib === void 0) continue;
      const lo = Math.min(ia, ib);
      const hi = Math.max(ia, ib);
      const key = `${lo}\0${hi}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (classifyPair(fa, fb) !== "candidate") continue;
      const edge = edgeBetween(edgeIndex, ia, ib);
      if (edge === void 0) continue;
      const w = edgeWeight(edge);
      if (w > 0) sum += w;
    }
  }
  return sum;
}
function conflicts(analysis, edges, files, tasks, lexical = {}) {
  const modOf = moduleOfFile(analysis);
  const idOf = new Map(files.map((f, i) => [f, i]));
  const edgeIndex = buildEdgeIndex(edges);
  const surfaces = tasks.map((t) => surfaceFor(t, files, modOf, lexical));
  const noise = /* @__PURE__ */ new Map();
  const isNoise = (f) => {
    const cached = noise.get(f);
    if (cached !== void 0) return cached;
    const value = isNoiseOnItsOwn(f, files);
    noise.set(f, value);
    return value;
  };
  const pairs = [];
  for (let i = 0; i < surfaces.length; i++) {
    for (let j = i + 1; j < surfaces.length; j++) {
      const x = surfaces[i];
      const y = surfaces[j];
      if (x === void 0 || y === void 0) continue;
      const [left, right] = compare(x.task.id, y.task.id) <= 0 ? [x, y] : [y, x];
      const shared = left.files.filter((f) => right.files.includes(f) && !isNoise(f)).sort(compare);
      const coupled = coupledScore(left.files, right.files, idOf, edgeIndex, isNoise);
      if (shared.length === 0 && coupled <= 0) continue;
      const modules = [...left.modules].filter((m) => right.modules.has(m)).sort(compare);
      pairs.push({ a: left.task.id, b: right.task.id, mode: "predicted", shared, coupled, modules });
    }
  }
  pairs.sort(
    (p, q) => q.shared.length - p.shared.length || q.coupled - p.coupled || compare(p.a, q.a) || compare(p.b, q.b)
  );
  const covered = [];
  const uncovered = [];
  for (const s of surfaces) (s.files.length > 0 ? covered : uncovered).push(s.task.id);
  return { pairs, covered: covered.sort(compare), uncovered: uncovered.sort(compare) };
}

// src/doctor.ts
import { existsSync as existsSync5 } from "node:fs";
import { join as join7, relative as relative2 } from "node:path";
function doctor(repoRoot, config) {
  const checks = [];
  if (!existsSync5(join7(repoRoot, ".git"))) {
    checks.push({
      name: "repository",
      state: "missing",
      detail: "not a git repository \u2014 history is the only required input",
      fix: "run inside a git repository",
      required: true
    });
    return { status: "blocked", checks };
  }
  let analysable;
  let files;
  try {
    const commits = harvest(repoRoot, { maxCommitFiles: config.maxCommitFiles });
    analysable = commits.length;
    files = [...new Set(commits.flatMap((c) => c.files))].sort(compare);
  } catch {
    checks.push({
      name: "repository",
      state: "missing",
      detail: "git log failed \u2014 no commits?",
      fix: "make at least one commit",
      required: true
    });
    return { status: "blocked", checks };
  }
  checks.push({ name: "repository", state: "ok", detail: repoRoot, required: true });
  const squash = squashShape(repoRoot, { maxCommitFiles: config.maxCommitFiles });
  const thin = historyIsThin(analysable, config);
  checks.push({
    name: "history depth",
    state: thin ? "warn" : "ok",
    detail: thin ? `${analysable} analysable commits \u2014 co-change needs ~${config.minCommits} to be meaningful` : `${analysable} analysable commits`,
    // The default advice is wrong on a squash-merged repository, and wrong in
    // the expensive direction: it sends someone to re-clone a repository whose
    // clone is already complete. Say what actually happened instead.
    fix: thin ? squash.dominated ? "nothing to unshallow \u2014 this repository squash-merges, so per-branch history was discarded at merge time; expect a sparse discovered graph and rely on the declared spine" : "unshallow the clone, or accept sparse output" : void 0,
    required: true
  });
  if (squash.squashed > 0) {
    checks.push({
      name: "history shape",
      state: squash.dominated ? "warn" : "ok",
      detail: `${squash.squashed} of ${squash.total} commits look like squashed pull requests` + (squash.droppedSquash > 0 ? `, and ${squash.droppedSquash} exceeded max-commit-files and were dropped entirely` : ""),
      // This module's contract is that every non-`ok` check names a fix,
      // because "a degradation reported without a remedy is a complaint" —
      // and `test/doctor.test.ts` enforces it. Nothing here RECOVERS the
      // discarded history, so the honest remedy is what to do given it,
      // not a repair. Saying "none available" would satisfy the letter of
      // the invariant and betray its point.
      fix: squash.dominated ? "read `map` as declared-structure-first: the spine and its dependency edges are unaffected, and `own` still resolves through each task's merge SHA \u2014 it is `drift` and working sets that will be sparse, so treat their absence as missing evidence rather than as evidence of absence" : void 0,
      // `required: false` on purpose: this is a property of how the project
      // merges, not a broken input, and grading a repository degraded forever
      // for its merge strategy is noise rather than honesty. `history depth`
      // already carries the grade.
      required: false
    });
  }
  const outDir = resolveOut(repoRoot, config);
  const outRel = relative2(repoRoot, outDir) || outDir;
  if (isIgnored(repoRoot, join7(outDir, "clusters.json"))) {
    checks.push({
      name: "artifact durability",
      state: "warn",
      detail: `${outRel} is gitignored, so clusters.json is never committed and cluster ids reset on every fresh clone and CI run`,
      fix: `commit ${outRel}/clusters.json if you want stable cluster ids across machines \u2014 or leave it ignored and read clusterIds as meaningless, but do not read "N fresh" as churn`,
      required: false
    });
  }
  const counted = files.filter((f) => !isExcludedPath(f, config.excludePaths));
  const shares = /* @__PURE__ */ new Map();
  for (const f of counted) {
    const top = f.includes("/") ? f.slice(0, f.indexOf("/")) : "(root files)";
    shares.set(top, (shares.get(top) ?? 0) + 1);
  }
  const ranked = [...shares.entries()].sort((a, b) => b[1] - a[1] || compare(a[0], b[0])).map(([dir, n]) => ({ dir, n, pct: Math.round(100 * n / Math.max(1, counted.length)) }));
  const composition = ranked.slice(0, 3).map((r) => `${r.dir} ${r.pct}%`).join(", ");
  const unexcludedTooling = ranked.filter((r) => r.dir.startsWith(".") && r.pct >= 5);
  checks.push({
    name: "graph composition",
    state: unexcludedTooling.length > 0 ? "warn" : "ok",
    detail: `${counted.length} files after exclusions; largest contributors ${composition}` + (unexcludedTooling.length > 0 ? ` \u2014 ${unexcludedTooling.map((r) => `${r.dir} (${r.pct}%)`).join(", ")} look like tooling rather than architecture` : ""),
    fix: unexcludedTooling.length > 0 ? `if those are not part of your architecture, add them to octograph.yaml:
    excludePaths:
` + unexcludedTooling.map((r) => `      - ${r.dir}/`).join("\n") + `
  octograph does not decide this for you \u2014 a directory can legitimately dominate a graph.` : void 0,
    // Advisory. A repository's layout is not a broken input, and grading it
    // down for one would be the same overreach as excluding docs by default.
    required: false
  });
  const spine = declaredSpine(repoRoot, files);
  const graphPath = graphifyGraphPath(repoRoot);
  const graphRel = relative2(repoRoot, graphPath);
  const graphifyPresent = existsSync5(graphPath);
  const graphifyUsable = spine.source === "graphify";
  checks.push({
    name: "graphify",
    state: graphifyUsable ? "ok" : graphifyPresent ? "warn" : "missing",
    detail: graphifyUsable ? `${graphRel} read \u2014 ${spine.imports.length} declared import edges, precise boundaries available` : graphifyPresent ? `${graphRel} found but yielded no cross-module import edges (truncated or empty run?) \u2014 the spine falls back to ${spine.source}` : (
      // What this function ACTUALLY observed is the absence of a file, and
      // it used to report that as "not installed" — a claim about the
      // machine that nothing here checks. The two differ on the ordinary
      // case of a developer who has Graphify installed and has never run
      // it in this repo, and they contradicted each other out loud in
      // `runSetup`, which printed "`uv tool install graphifyy`
      // succeeded." and then, four lines down, "not installed — fix: uv
      // tool install graphifyy". Installing the tool cannot produce this
      // file; only running it can, which is why the fix below leads with
      // that.
      `${graphRel} not found \u2014 no Graphify output in this repo, so drift can say "different modules" but not "nothing imports across them"`
    ),
    fix: graphifyUsable ? void 0 : graphifyPresent ? `re-run graphify, or delete ${graphRel} if it is stale` : `run Graphify in this repo to produce ${graphRel} \u2014 install it with \`uv tool install graphifyy\` if you have not`,
    required: false
  });
  const board = hasBoard(repoRoot);
  checks.push({
    name: "board",
    state: board ? "ok" : "missing",
    detail: board ? ".octobots/ found" : "no board \u2014 own/conflicts unavailable",
    // Every non-ok check names a fix — see the invariant on `doctor` above.
    fix: board ? void 0 : "plan work onto an .octobots/ board, or ignore this",
    required: false
  });
  const degraded = checks.some((c) => c.required && c.state !== "ok");
  return { status: degraded ? "degraded" : "ok", checks };
}
function exitCode(report) {
  return report.status === "ok" ? 0 : 1;
}

// src/rank.ts
function rankScore(weight, support, minSupport) {
  return weight * (support / (support + minSupport));
}

// src/drift.ts
function declaredPairs(imports) {
  const byModule = /* @__PURE__ */ new Map();
  const relate = (from, to) => {
    const peers = byModule.get(from);
    if (peers) peers.add(to);
    else byModule.set(from, /* @__PURE__ */ new Set([to]));
  };
  for (const e of imports) {
    relate(e.from, e.to);
    relate(e.to, e.from);
  }
  return byModule;
}
function drift(edges, files, spine, limit = 20, minSupport = 2) {
  const declared = declaredPairs(spine.imports);
  const keep = limit > 0 ? limit : 0;
  const scored = [];
  for (const e of edges) {
    if (isSyntheticBridge(e)) continue;
    const weight = edgeWeight(e);
    if (weight <= 0) continue;
    const left = files[e.a];
    const right = files[e.b];
    if (left === void 0 || right === void 0) continue;
    const swapped = compare(left, right) > 0;
    const pa = swapped ? right : left;
    const pb = swapped ? left : right;
    if (classifyPair(pa, pb) !== "candidate") continue;
    const ma = spine.moduleOf(pa);
    const mb = spine.moduleOf(pb);
    if (ma === mb) continue;
    if (declared.get(ma)?.has(mb) === true) continue;
    scored.push({
      row: {
        a: pa,
        b: pb,
        moduleA: ma,
        moduleB: mb,
        npmi: weight,
        support: e.support,
        confidence: e.confidence
      },
      score: rankScore(weight, e.support, minSupport)
    });
  }
  scored.sort(
    (x, y) => y.score - x.score || compare(x.row.a, y.row.a) || compare(x.row.b, y.row.b)
  );
  return scored.slice(0, keep).map((s) => s.row);
}

// src/impact.ts
function impact(path, edges, files, limit = 20, minSupport = 2) {
  const id = files.indexOf(path);
  if (id === -1) return [];
  const scored = [];
  for (const e of edges) {
    const other = e.a === id ? e.b : e.b === id ? e.a : -1;
    if (other === -1) continue;
    const weight = edgeWeight(e);
    if (weight <= 0) continue;
    const p = files[other];
    if (p === void 0) continue;
    scored.push({
      row: { path: p, npmi: weight, support: e.support, confidence: e.confidence },
      score: rankScore(weight, e.support, minSupport)
    });
  }
  scored.sort((x, y) => y.score - x.score || compare(x.row.path, y.row.path));
  return scored.slice(0, limit).map((s) => s.row);
}

// src/own.ts
import { statSync as statSync3 } from "node:fs";

// src/attribution.ts
import { execFileSync as execFileSync2 } from "node:child_process";
var OBJECT_NAME = /^[0-9a-f]{7,64}$/;
function filesChangedBy(repoRoot, sha) {
  if (!OBJECT_NAME.test(sha)) return null;
  try {
    const out = execFileSync2(
      "git",
      [
        "diff-tree",
        "--no-commit-id",
        "--name-status",
        "-r",
        "-z",
        "--diff-merges=first-parent",
        "--root",
        sha
      ],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const tokens = out.split("\0").filter((t) => t !== "");
    const kept = /* @__PURE__ */ new Set();
    const deleted = /* @__PURE__ */ new Set();
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const status = tokens[i];
      const file = tokens[i + 1];
      if (status === void 0 || file === void 0) continue;
      (status.startsWith("D") ? deleted : kept).add(file);
    }
    return { kept: [...kept].sort(compare), deleted: [...deleted].sort(compare) };
  } catch {
    return null;
  }
}
var SHORT_ID = /^(T\d+\.\d+)\b/;
var defaultWarn = (message) => {
  process.stderr.write(message);
};
function campaignSlug(campaignId) {
  const idx = campaignId.lastIndexOf("/");
  return idx === -1 ? campaignId : campaignId.slice(idx + 1);
}
function disambiguateByBranch(candidates, branch) {
  if (branch === null) return [];
  const matches = candidates.filter((t) => branch.includes(campaignSlug(t.campaign)));
  return matches.length === 1 ? matches : [];
}
function resolveEntryTask(entry, byId, byShortId) {
  if (entry.task === null) return [];
  const direct = byId.get(entry.task);
  if (direct !== void 0) return [direct];
  const candidates = byShortId.get(entry.task) ?? [];
  if (candidates.length <= 1) return candidates;
  return disambiguateByBranch(candidates, entry.branch);
}
function attribute(repoRoot, board, log2, warn = defaultWarn) {
  const byId = new Map(board.tasks.map((t) => [t.id, t]));
  const byShortId = /* @__PURE__ */ new Map();
  for (const t of board.tasks) {
    const short = SHORT_ID.exec(t.name)?.[1];
    if (short === void 0) continue;
    const existing = byShortId.get(short);
    if (existing !== void 0) existing.push(t);
    else byShortId.set(short, [t]);
  }
  const evidence = /* @__PURE__ */ new Map();
  for (const entry of log2) {
    if (entry.task === null || entry.mergedSha === null) continue;
    const resolved = resolveEntryTask(entry, byId, byShortId);
    if (resolved.length !== 1) {
      const candidates = byShortId.get(entry.task) ?? [];
      if (filesChangedBy(repoRoot, entry.mergedSha) !== null) {
        if (candidates.length > 1) {
          const names = candidates.map((t) => t.id).sort(compare).join(", ");
          warn(
            `octograph: worklog entry for task "${entry.task}" (branch: ${entry.branch ?? "(none)"}) matches ${candidates.length} board tasks and could not be resolved to exactly one \u2014 candidates: ${names}
`
          );
        } else {
          warn(
            `octograph: worklog entry for task "${entry.task}" (branch: ${entry.branch ?? "(none)"}) carries a merge SHA that still resolves here but names no task on this board \u2014 its provenance is dropped
`
          );
        }
      }
      continue;
    }
    const task = resolved[0];
    if (task === void 0) continue;
    const rec = { sha: entry.mergedSha, at: entry.at };
    const existing = evidence.get(task.id);
    if (existing !== void 0) existing.push(rec);
    else evidence.set(task.id, [rec]);
  }
  return board.tasks.map((task) => {
    const list = evidence.get(task.id);
    if (list !== void 0) {
      const sorted = [...list].sort((a, b) => compare(b.at, a.at));
      for (let i = 0; i < sorted.length; i++) {
        const rec = sorted[i];
        if (rec === void 0) continue;
        const changed = filesChangedBy(repoRoot, rec.sha);
        if (changed === null || changed.kept.length === 0) continue;
        if (i > 0) {
          const skipped = sorted.slice(0, i).map((r) => `${r.sha} (at ${r.at})`).join(", ");
          warn(
            `octograph: task "${task.id}" \u2014 newer worklog evidence could not be used (${skipped}); falling back to older evidence: ${rec.sha} (at ${rec.at})
`
          );
        }
        return { task: task.id, files: changed.kept, deletedFiles: changed.deleted, mode: "provenance" };
      }
    }
    return { task: task.id, files: [], deletedFiles: [], mode: "predicted" };
  });
}

// src/own.ts
function bestCriterion(criteria, path) {
  const pathTokens = new Set(tokenize(path));
  let top = null;
  let tied = false;
  for (const criterion of criteria) {
    const score = tokenize(criterion).filter((t) => pathTokens.has(t)).length;
    if (top === null || score > top.score) {
      top = { text: criterion, score };
      tied = false;
    } else if (score === top.score) {
      tied = true;
    }
  }
  if (top === null || top.score === 0 || tied) return null;
  return top.text;
}
function isRepoFile(repoRoot, path) {
  const abs = insideRepo(repoRoot, path);
  if (abs === null) return false;
  try {
    return statSync3(abs).isFile();
  } catch {
    return false;
  }
}
function withCandidate(repoRoot, candidates, path) {
  if (candidates.includes(path)) return [...candidates];
  if (!isRepoFile(repoRoot, path)) return [...candidates];
  return [...candidates, path].sort(compare);
}
function filesFor(repoRoot, task, mode, provenanceFiles, candidates, path, lexical) {
  if (mode === "provenance") {
    return path === null ? [...provenanceFiles] : provenanceFiles.filter((f) => f === path);
  }
  const corpus = path === null ? candidates : withCandidate(repoRoot, candidates, path);
  const predicted = predictFiles(task.criteria, corpus, lexical).map((m) => m.file);
  return path === null ? predicted : predicted.filter((f) => f === path);
}
function own(repoRoot, board, log2, candidates, path, lexical = {}, warn = defaultWarn) {
  const attributions = attribute(repoRoot, board, log2);
  const byTask = new Map(board.tasks.map((t) => [t.id, t]));
  const answers = [];
  for (const a of attributions) {
    const task = byTask.get(a.task);
    if (task === void 0) continue;
    const mission = board.missionOf(task.id);
    if (mission === null) continue;
    const missionName = board.missionNameOf(task.id);
    if (missionName === null) continue;
    if (path !== null && a.mode === "provenance" && a.deletedFiles.includes(path)) {
      warn(
        `octograph: "${path}" was deleted by ${task.name}'s recorded merge \u2014 it has no current owner
`
      );
    }
    for (const file of filesFor(repoRoot, task, a.mode, a.files, candidates, path, lexical)) {
      const criterion = bestCriterion(task.criteria, file);
      answers.push({
        path: file,
        task: task.id,
        taskName: task.name,
        mission,
        missionName,
        criterion,
        mode: a.mode,
        // Derived from whether a criterion was named, never from `a.mode`:
        // the two halves of this row are reached by two different kinds of
        // evidence and are labelled separately (see OwnAnswer.criterionMode).
        criterionMode: criterion === null ? null : "predicted"
      });
    }
  }
  answers.sort(
    (x, y) => compare(x.mission, y.mission) || compare(x.task, y.task) || compare(x.path, y.path)
  );
  return answers;
}

// src/render.ts
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
var oneLine = (s) => (
  // eslint-disable-next-line no-control-regex
  s.replace(/[\u0000-\u001f\u007f]/gu, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
);
function renderMap(analysis, budgetTokens) {
  const header = [
    "# Module map",
    "",
    `- commits analysed: ${analysis.commitCount}`,
    // Not "files": `fileCount` is `PairTable.files.length`, i.e. only the files
    // that appear in an analysable commit touching two or more paths. On this
    // repo that is a third of the tracked tree. A bare "files: N" reads as a
    // repo total, which is the partial-presented-as-total failure the header
    // line below already guards for the Modules section.
    `- files in the co-change graph: ${analysis.fileCount}`,
    `- declared spine: ${analysis.spineSource}`,
    `- hubs quarantined: ${analysis.hubs.length}`,
    "- files never co-changed with another file: omitted below",
    "",
    "## Modules",
    "",
    // What a module row actually counts. `analyze` names each row for a
    // Louvain community's most central file (or a hub's own declared module,
    // or a Graphify-only endpoint — see analyze.ts), but the FILES listed
    // under it are that module's declared membership
    // (`filesByModule(table.files, spine.moduleOf)`), per spec A5c: "module
    // identity comes from the declared spine when present." A community can
    // sweep in files declared under a different module than the one whose
    // name it won; those files stay listed under their own declared row, not
    // under whichever heading absorbed their community. Without this line the
    // count reads as "this module contains N files" without saying which N.
    "_A row's files are the declared module's own membership; the row is named for the community that won the naming vote, but that community's other members are not counted here \u2014 see each of THEIR declared rows instead._",
    ""
  ];
  const countLabel = (members) => {
    const testCount = members.filter((p) => isTestPath(p)).length;
    const sourceCount = members.length - testCount;
    return testCount === 0 ? `${sourceCount} co-changed files` : `${sourceCount} source, ${testCount} test co-changed files`;
  };
  const scores = modulePageRank(
    analysis.moduleEdges,
    analysis.modules.map((m) => m.name)
  );
  const ranked = [...analysis.modules].sort(
    (a, b) => (scores.get(b.name) ?? 0) - (scores.get(a.name) ?? 0) || compare(a.name, b.name)
  );
  const lines = [];
  for (const m of ranked) {
    const layer = m.layer === null ? "" : ` [layer ${m.layer}]`;
    lines.push(`- **${oneLine(m.name)}**${layer} \u2014 ${countLabel(m.members)}`);
  }
  const directed = analysis.moduleEdgesDirected;
  const section = directed ? "## Dependencies" : "## Coupling (undirected co-change)";
  const link = directed ? "\u2192" : "\u2194";
  const edgeUnit = directed ? "dependency edge" : "coupling edge";
  const weightUnit = directed ? "_Weight is the number of declared import edges between the two modules._" : "_Weight is summed decayed nPMI over co-changed file pairs, not a count._";
  const shownModules = (keptModules2) => new Set(ranked.slice(0, keptModules2).map((m) => m.name));
  const visibleEdges = (keptModules2) => {
    const shown = shownModules(keptModules2);
    return analysis.moduleEdges.filter((e) => shown.has(e.from) && shown.has(e.to)).map((e) => `- ${oneLine(e.from)} ${link} ${oneLine(e.to)} (${e.weight.toFixed(2)})`);
  };
  const note = (dropped, unit) => dropped > 0 ? ["", `_${dropped} ${unit}(s) truncated to fit the token budget._`] : [];
  const WORKING_SETS_NOTE = "_Each entry is one co-change community whose files span two or more declared modules. Observed from commit history; a working set is evidence of coupling, not a proposal to change any boundary. Membership is the community's own: quarantined hubs and test files are held out of clustering, so a file that moves with the set can be absent from its list and its count._";
  const visibleSets = (keptModules2) => {
    const shown = shownModules(keptModules2);
    return analysis.workingSets.filter((w) => w.modules.every((m) => shown.has(m)));
  };
  const setLines = (sets) => sets.flatMap((w) => [
    // `w.files.length`, never the rendered lines' length: the count is the
    // claim about the COMMUNITY, and `oneLine` must not be able to change it
    // — which is exactly why it exists (see its own comment).
    `- **${oneLine(w.name)}** \u2014 ${w.files.length} files across ${w.modules.map(oneLine).join(", ")}`,
    ...w.files.map((f) => `  - ${oneLine(f)}`)
  ]);
  const shownSetsFor = (keptModules2, keptSets2) => visibleSets(keptModules2).slice(0, Math.max(0, keptSets2));
  const compose = (keptModules2, keptEdges2, keptSets2) => {
    const shownEdges = visibleEdges(keptModules2).slice(0, Math.max(0, keptEdges2));
    const shownSets = shownSetsFor(keptModules2, keptSets2);
    return [
      ...header,
      ...lines.slice(0, keptModules2),
      ...note(lines.length - keptModules2, "module"),
      "",
      section,
      "",
      weightUnit,
      "",
      ...shownEdges,
      // Counted against the FULL edge list, not against what survived the
      // endpoint filter: an edge hidden because its module was trimmed is
      // still an edge the reader is not being shown, and both causes are the
      // budget.
      ...note(analysis.moduleEdges.length - shownEdges.length, edgeUnit),
      // The heading itself is conditional (criterion 1: an empty result is
      // NO heading, not an empty one) but the truncation note is not — a
      // working set cut down to zero by the budget is still something the
      // reader is not being shown, exactly the edge-section precedent above.
      ...shownSets.length > 0 ? ["", "## Working sets", "", WORKING_SETS_NOTE, "", ...setLines(shownSets)] : [],
      ...note(analysis.workingSets.length - shownSets.length, "working set")
    ].join("\n") + "\n";
  };
  const shrink = (n) => Math.max(0, n - Math.max(1, Math.ceil(n / 8)));
  let keptModules = lines.length;
  let keptEdges = analysis.moduleEdges.length;
  let keptSets = analysis.workingSets.length;
  let out = compose(keptModules, keptEdges, keptSets);
  while (estimateTokens(out) > budgetTokens) {
    const shownEdges = Math.min(keptEdges, visibleEdges(keptModules).length);
    const sets = shownSetsFor(keptModules, keptSets);
    const shownSets = sets.length;
    const setLineCount = setLines(sets).length;
    if (keptModules + shownEdges + shownSets === 0) break;
    if (keptModules >= shownEdges && keptModules >= setLineCount) keptModules = shrink(keptModules);
    else if (shownEdges >= keptModules && shownEdges >= setLineCount) keptEdges = shrink(shownEdges);
    else keptSets = shrink(shownSets);
    out = compose(keptModules, keptEdges, keptSets);
  }
  return out;
}

// src/worklog.ts
import { readFileSync as readFileSync6 } from "node:fs";
import { join as join8 } from "node:path";
function optString2(raw, key) {
  const v = raw[key];
  return typeof v === "string" ? v : null;
}
function parseLine(line, warn) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const raw = parsed;
  const sessionId = optString2(raw, "session_id");
  const at = optString2(raw, "at");
  if (sessionId === null || at === null) {
    const missing = [
      sessionId === null ? "session_id" : null,
      at === null ? "at" : null
    ].filter((field) => field !== null);
    warn(
      `octograph: worklog line is valid JSON but missing required field(s) (${missing.join(", ")}) \u2014 dropped: ${line}
`
    );
    return null;
  }
  return {
    sessionId,
    task: optString2(raw, "task"),
    mission: optString2(raw, "mission"),
    branch: optString2(raw, "branch"),
    mergedSha: optString2(raw, "merged_sha"),
    at
  };
}
function readWorklog(repoRoot, warn = defaultWarn) {
  const root = boardDir(repoRoot);
  if (root === null) return [];
  let text;
  try {
    text = readFileSync6(join8(root, "tokenomics", "worklog.jsonl"), "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const entry = parseLine(line, warn);
    if (entry) entries.push(entry);
  }
  return entries;
}

// src/cli.ts
var COMMANDS = ["map", "impact", "drift", "doctor", "own", "conflicts"];
function isCommand(value) {
  return COMMANDS.includes(value);
}
function toFiniteNumber(raw) {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
function parseArgs(argv2) {
  const [rawCommand, ...rest] = argv2;
  if (rawCommand === void 0) {
    return { ok: false, error: `missing command \u2014 expected one of: ${COMMANDS.join(", ")}` };
  }
  if (!isCommand(rawCommand)) {
    return {
      ok: false,
      error: `unknown command "${rawCommand}" \u2014 expected one of: ${COMMANDS.join(", ")}`
    };
  }
  const positionals = [];
  const overrides = {};
  let since;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === void 0) break;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    const takeValue = () => {
      const v = rest[i + 1];
      if (v === void 0 || v.startsWith("--")) return null;
      i += 1;
      return v;
    };
    const missingValue = () => ({ ok: false, error: `${arg} requires a value` });
    const notANumber = (v) => ({
      ok: false,
      error: `${arg} expects a number, got "${v}"`
    });
    switch (arg) {
      case "--out": {
        const value = takeValue();
        if (value === null) return missingValue();
        overrides.out = value;
        break;
      }
      case "--since": {
        const value = takeValue();
        if (value === null) return missingValue();
        since = value;
        break;
      }
      case "--max-commit-files": {
        const value = takeValue();
        if (value === null) return missingValue();
        const n = toFiniteNumber(value);
        if (n === null) return notANumber(value);
        overrides.maxCommitFiles = n;
        break;
      }
      case "--half-life": {
        const value = takeValue();
        if (value === null) return missingValue();
        const n = toFiniteNumber(value);
        if (n === null) return notANumber(value);
        overrides.halfLifeDays = n;
        break;
      }
      case "--min-support": {
        const value = takeValue();
        if (value === null) return missingValue();
        const n = toFiniteNumber(value);
        if (n === null) return notANumber(value);
        overrides.minSupport = n;
        break;
      }
      case "--min-commits": {
        const value = takeValue();
        if (value === null) return missingValue();
        const n = toFiniteNumber(value);
        if (n === null) return notANumber(value);
        overrides.minCommits = n;
        break;
      }
      case "--budget": {
        const value = takeValue();
        if (value === null) return missingValue();
        const n = toFiniteNumber(value);
        if (n === null) return notANumber(value);
        overrides.budgetTokens = n;
        break;
      }
      default:
        return { ok: false, error: `unrecognised flag: ${arg}` };
    }
  }
  return { ok: true, parsed: { command: rawCommand, positionals, overrides, since, json } };
}
function usageError(message) {
  return { code: 2, stdout: "", stderr: `octograph: ${message}
` };
}
function runtimeError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return { code: 1, stdout: "", stderr: `octograph: ${message}
` };
}
function formatDoctor(report) {
  const lines = [`status: ${report.status}`, ""];
  for (const c of report.checks) {
    lines.push(`[${c.state}] ${c.name}: ${c.detail}`);
    if (c.fix !== void 0) lines.push(`  fix: ${c.fix}`);
  }
  return lines.join("\n") + "\n";
}
function formatImpactRow(row) {
  const { path, npmi, support, confidence } = row;
  return `${path}	npmi=${npmi.toFixed(3)}	support=${support}	confidence=${confidence.toFixed(3)}`;
}
function formatImpact(rows) {
  if (rows.length === 0) return "(no coupled files)\n";
  return rows.map(formatImpactRow).join("\n") + "\n";
}
function formatDriftRow(row) {
  const { a, b, moduleA, moduleB, npmi, support, confidence } = row;
  return `${a} <-> ${b}  (${moduleA} <-> ${moduleB})	npmi=${npmi.toFixed(3)}	support=${support}	confidence=${confidence.toFixed(3)}`;
}
function formatDrift(rows) {
  if (rows.length === 0) return "(no undeclared coupling above the noise floor)\n";
  return rows.map(formatDriftRow).join("\n") + "\n";
}
function runDoctorCommand(repoRoot, config, json) {
  const report = doctor(repoRoot, config);
  const stdout = json ? JSON.stringify(report) + "\n" : formatDoctor(report);
  return { code: exitCode(report), stdout, stderr: "" };
}
function clustersToMap(clusters) {
  const map = /* @__PURE__ */ new Map();
  for (const [id, members] of Object.entries(clusters)) map.set(Number(id), members);
  return map;
}
function analysisToClusters(analysis) {
  const clusters = {};
  for (const m of analysis.modules) clusters[m.id] = m.members;
  return clusters;
}
function describeSince(since) {
  return since === null ? "full history" : `--since ${since}`;
}
function sinceMismatchWarning(previous, since) {
  if (previous === null || previous.since === void 0) return "";
  const previousSince = previous.since;
  const currentSince = since ?? null;
  if (previousSince === currentSince) return "";
  return `octograph: warning: clusters.json was built with ${describeSince(previousSince)}, this run uses ${describeSince(currentSince)} \u2014 cluster-id stability across mismatched history windows is not meaningful
`;
}
function sincePredictedWarning(since) {
  if (since === void 0) return "";
  return `octograph: --since ${since} narrows the co-change corpus predicted answers are scored against \u2014 the same query can answer differently under a different window; provenance answers are unaffected
`;
}
function runMapCommand(repoRoot, config, since, now, json) {
  const outDir = resolveOut(repoRoot, config);
  const previous = readArtifact(outDir);
  const previousClusters = previous ? clustersToMap(previous.clusters) : /* @__PURE__ */ new Map();
  const sinceWarning = sinceMismatchWarning(previous, since);
  const { analysis } = analyze(repoRoot, config, { now, since, previousClusters });
  const mapText = renderMap(analysis, config.budgetTokens);
  mkdirSync2(outDir, { recursive: true });
  writeFileSync2(join9(outDir, "map.md"), mapText);
  writeArtifact(outDir, {
    version: 1,
    clusters: analysisToClusters(analysis),
    config,
    // Every NEW artifact this CLI writes records its own provenance
    // explicitly — `null` for full history, never left `undefined`. That
    // spelling is reserved for artifacts written before this field existed
    // (see StoredGraph.since); this run always knows the answer.
    since: since ?? null
  });
  const relOut = relative3(repoRoot, outDir) || ".";
  const stdout = json ? JSON.stringify({
    outDir: relOut,
    modules: analysis.modules.length,
    moduleEdges: analysis.moduleEdges.length,
    clusterIds: analysis.clusterIds
  }) + "\n" : `wrote ${relOut}/map.md and ${relOut}/clusters.json \u2014 ${analysis.modules.length} modules, ${analysis.moduleEdges.length} edges (${analysis.clusterIds.kept} kept, ${analysis.clusterIds.fresh} fresh cluster ids)
`;
  return { code: 0, stdout, stderr: sinceWarning };
}
function runImpactCommand(repoRoot, config, since, now, rawPath, json) {
  const { edges, files } = analyze(repoRoot, config, { now, since });
  const path = repoRelative(repoRoot, rawPath) ?? rawPath;
  const rows = impact(path, edges, files, void 0, config.minSupport);
  const stdout = json ? JSON.stringify(rows) + "\n" : formatImpact(rows);
  return { code: 0, stdout, stderr: "" };
}
function formatOwnAnswer(a) {
  const criterion = a.criterion === null || a.criterionMode === null ? "criterion: none \u2014 no acceptance criterion's own words single out this path" : `criterion (${a.criterionMode}): ${oneLine(a.criterion)}`;
  return `${oneLine(a.path)}	owned by ${oneLine(a.missionName)} / ${oneLine(a.taskName)} (${a.mode})	${criterion}`;
}
function formatOwn(answers) {
  if (answers.length === 0) return "(no owner found)\n";
  return answers.map(formatOwnAnswer).join("\n") + "\n";
}
function runOwnCommand(repoRoot, config, since, now, rawPath, json) {
  const board = readBoard(repoRoot);
  if (board === null) {
    return {
      code: 1,
      stdout: "",
      stderr: "octograph: no .octobots board found \u2014 own needs one to answer\n"
    };
  }
  const log2 = readWorklog(repoRoot);
  const { files } = analyze(repoRoot, config, { now, since });
  const path = rawPath === null ? null : repoRelative(repoRoot, rawPath) ?? rawPath;
  const answers = own(repoRoot, board, log2, files, path, lexicalOptions(config));
  const stdout = json ? JSON.stringify(answers) + "\n" : formatOwn(answers);
  return { code: 0, stdout, stderr: sincePredictedWarning(since) };
}
function runDriftCommand(repoRoot, config, since, now, json) {
  const { edges, files, spine } = analyze(repoRoot, config, { now, since });
  const rows = drift(edges, files, spine, void 0, config.minSupport);
  const stdout = json ? JSON.stringify(rows) + "\n" : formatDrift(rows);
  return { code: 0, stdout, stderr: "" };
}
function formatModuleList(modules) {
  return modules.length === 0 ? "(none)" : modules.map(oneLine).join(", ");
}
function formatConflictPair(p) {
  const shared = p.shared.length === 0 ? "(none)" : p.shared.map(oneLine).join(", ");
  return `${oneLine(p.a)} <-> ${oneLine(p.b)} (${p.mode})	shared=${shared}	coupled=${p.coupled.toFixed(3)}	modules=${formatModuleList(p.modules)}`;
}
function formatCoverage(report) {
  const total = report.covered.length + report.uncovered.length;
  const head = `coverage (predicted): ${report.covered.length} of ${total} tasks produced a predicted surface`;
  if (report.uncovered.length === 0) return head;
  return `${head} \u2014 this answer says nothing about the other ${report.uncovered.length}: ` + report.uncovered.map(oneLine).join(", ");
}
function formatConflicts(report) {
  const rows = report.pairs.length === 0 ? ["(no conflicts found)"] : report.pairs.map(formatConflictPair);
  return [...rows, formatCoverage(report)].join("\n") + "\n";
}
function resolveConflictTasks(board, positionals) {
  if (positionals.length === 1) {
    const id = positionals[0];
    if (id === void 0) return { ok: false, error: "conflicts requires an id" };
    const byCampaign = board.tasks.filter((t) => t.campaign === id);
    if (byCampaign.length > 0) return { ok: true, tasks: byCampaign };
    const byMission = board.tasks.filter((t) => t.mission === id);
    if (byMission.length > 0) return { ok: true, tasks: byMission };
    const byTask = board.tasks.filter((t) => t.id === id);
    if (byTask.length > 0) return { ok: true, tasks: byTask };
    return { ok: false, error: `no campaign, mission, or task matches "${id}"` };
  }
  const wanted = new Set(positionals);
  const tasks = board.tasks.filter((t) => wanted.has(t.id));
  const found = new Set(tasks.map((t) => t.id));
  const missing = positionals.filter((id) => !found.has(id));
  if (missing.length > 0) return { ok: false, error: `no task matches: ${missing.join(", ")}` };
  return { ok: true, tasks };
}
function runConflictsCommand(repoRoot, config, since, now, positionals, json) {
  const board = readBoard(repoRoot);
  if (board === null) {
    return {
      code: 1,
      stdout: "",
      stderr: "octograph: no .octobots board found \u2014 conflicts needs one to answer\n"
    };
  }
  const resolved = resolveConflictTasks(board, positionals);
  if (!resolved.ok) return usageError(resolved.error);
  const { analysis, edges, files } = analyze(repoRoot, config, { now, since });
  const report = conflicts(analysis, edges, files, resolved.tasks, lexicalOptions(config));
  const stdout = json ? JSON.stringify(report) + "\n" : formatConflicts(report);
  return { code: 0, stdout, stderr: sincePredictedWarning(since) };
}
function runCli(argv2, repoRoot, now) {
  const parsed = parseArgs(argv2);
  if (!parsed.ok) return usageError(parsed.error);
  const { command, positionals, overrides, since, json } = parsed.parsed;
  const outFlag = typeof overrides.out === "string" ? overrides.out : null;
  if (outFlag !== null && insideRepo(repoRoot, outFlag) === null) {
    return usageError(
      `--out must name a path inside the repository, and "${outFlag}" resolves outside it`
    );
  }
  if (command === "impact") {
    if (positionals.length !== 1) {
      return usageError("impact requires exactly one <path> argument");
    }
  } else if (command === "own") {
    if (positionals.length > 1) {
      return usageError("own accepts at most one <path> argument");
    }
  } else if (command === "conflicts") {
    if (positionals.length === 0) {
      return usageError("conflicts requires a <mission>, <campaign>, or one or more <task> ids");
    }
  } else if (positionals.length > 0) {
    return usageError(`${command} takes no positional arguments`);
  }
  const config = loadConfig(repoRoot, overrides);
  try {
    switch (command) {
      case "doctor":
        return runDoctorCommand(repoRoot, config, json);
      case "map":
        return runMapCommand(repoRoot, config, since, now, json);
      case "drift":
        return runDriftCommand(repoRoot, config, since, now, json);
      case "impact": {
        const path = positionals[0];
        if (path === void 0) return usageError("impact requires exactly one <path> argument");
        return runImpactCommand(repoRoot, config, since, now, path, json);
      }
      case "own":
        return runOwnCommand(repoRoot, config, since, now, positionals[0] ?? null, json);
      case "conflicts":
        return runConflictsCommand(repoRoot, config, since, now, positionals, json);
    }
  } catch (err) {
    return runtimeError(err);
  }
}

// src/setup-io.ts
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
function isExecError(err) {
  return typeof err === "object" && err !== null;
}
async function exec(file, args) {
  try {
    const { stdout, stderr } = await execFileAsync(file, args);
    return { code: 0, stdout, stderr };
  } catch (err) {
    if (!isExecError(err)) return { code: 1, stdout: "", stderr: String(err) };
    const code = typeof err.code === "number" ? err.code : 1;
    const stdout = typeof err.stdout === "string" ? err.stdout : "";
    const stderr = typeof err.stderr === "string" ? err.stderr : typeof err.message === "string" ? err.message : "";
    return { code, stdout, stderr };
  }
}
async function which(file) {
  const lookup = process.platform === "win32" ? "where" : "which";
  const result = await exec(lookup, [file]);
  if (result.code !== 0) return null;
  const first = result.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== "");
  return first ?? null;
}
function prompt(question) {
  return new Promise((resolve3) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    const settle = (answer) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve3(/^\s*y(es)?\s*$/i.test(answer));
    };
    rl.on("close", () => settle(""));
    rl.question(question, settle);
  });
}
function log(line) {
  process.stdout.write(line.endsWith("\n") ? line : `${line}
`);
}
var realSetupIO = { prompt, log, exec, which };

// src/setup.ts
var GRAPHIFY_CHECK = "graphify";
var GRAPHIFY_BIN = "graphify";
var INSTALL_ARGV = ["uv", ["tool", "install", "graphifyy"]];
var UV_INSTALL_URL = "https://docs.astral.sh/uv/getting-started/installation/";
function findCheck(report, name) {
  return report.checks.find((c) => c.name === name);
}
function postflight(report) {
  return `octograph: setup finished \u2014 final state:
${formatDoctor(report).trimEnd()}`;
}
async function runSetup(repoRoot, config, now, io) {
  const report = doctor(repoRoot, config);
  if (report.status === "blocked") {
    io.log(postflight(report));
    return exitCode(report);
  }
  let mutated = false;
  let installFailed = false;
  const graphify = findCheck(report, GRAPHIFY_CHECK);
  if (graphify !== void 0 && graphify.state === "missing") {
    const [file, args] = INSTALL_ARGV;
    const uvPath = await io.which(file);
    if (uvPath === null) {
      installFailed = true;
      io.log(
        `octograph: \`uv\` not found on PATH \u2014 install it yourself from ${UV_INSTALL_URL}, then re-run \`octograph setup\` to install Graphify.`
      );
    } else {
      const consent = await io.prompt(
        `octograph: this repo has no Graphify output. Install Graphify now via \`uv tool install graphifyy\`? [y/N] `
      );
      if (consent) {
        const result = await io.exec(file, [...args]);
        mutated = true;
        if (result.code !== 0) {
          installFailed = true;
          io.log(`octograph: \`uv tool install graphifyy\` failed (exit ${result.code}).`);
        } else {
          const installed = await io.which(GRAPHIFY_BIN);
          if (installed === null) {
            installFailed = true;
            io.log(
              "octograph: `uv tool install graphifyy` exited 0 but left no `graphify` on PATH \u2014 nothing was installed that this run can find."
            );
          } else {
            io.log(
              `octograph: \`uv tool install graphifyy\` succeeded \u2014 \`graphify\` is on PATH at ${installed}. Run it in this repo to produce the graph the checks below grade.`
            );
          }
        }
      } else {
        io.log("octograph: skipping Graphify install \u2014 continuing without it.");
      }
    }
  }
  let build;
  try {
    build = runMapCommand(repoRoot, config, void 0, now, false);
  } catch (err) {
    build = runtimeError(err);
  }
  if (build.stdout) io.log(build.stdout.trimEnd());
  if (build.stderr) io.log(build.stderr.trimEnd());
  const finalReport = mutated ? doctor(repoRoot, config) : report;
  io.log(postflight(finalReport));
  if (build.code !== 0) return build.code;
  if (installFailed) return 1;
  return exitCode(finalReport);
}

// bin/octograph.mjs
var argv = process.argv.slice(2);
if (argv[0] === "setup") {
  if (argv.length > 1) {
    process.stderr.write("octograph: setup takes no arguments\n");
    process.exit(2);
  }
  const repoRoot = process.cwd();
  const config = loadConfig(repoRoot);
  const code = await runSetup(repoRoot, config, Date.now(), realSetupIO);
  process.exit(code);
} else {
  const result = runCli(argv, process.cwd(), Date.now());
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}
/*! Bundled license information:

js-yaml/dist/js-yaml.mjs:
  (*! js-yaml 5.2.2 https://github.com/nodeca/js-yaml @license MIT *)
*/
