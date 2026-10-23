#!/usr/bin/env node
/**
 * Bench harness for the JitRL experience store query path (P1-2, plan section 6.3).
 *
 * Generates a synthetic store (10k records over 200 buckets), warms the query
 * path up, then runs 2k nearest-neighbour queries and reports the p50/p95/p99
 * latencies plus the store build time as a single JSON object. The plan target
 * is p95 < 5ms single threaded; the script fails (exit 1) when the measured
 * p95 misses it, so a regression is visible in CI.
 *
 * The script is dependency free and deterministic: a seeded PRNG drives both
 * the corpus and the workload. It imports the TypeScript sources directly
 * (Node 22 strips the type annotations), so no build step is required.
 *
 * Usage: node scripts/bench-jitrl-query.mjs [recordCount] [bucketCount] [queryCount]
 */

import { performance } from 'node:perf_hooks';
import { register } from 'node:module';

// The sources are TypeScript with extensionless relative imports, so a one
// line resolver maps './x' to './x.ts' (Node 22 strips the annotations). This
// keeps the script dependency free and free of build artifacts.
const extensionResolver =
  "export async function resolve(specifier, context, nextResolve) {" +
  " try { return await nextResolve(specifier, context); }" +
  " catch (error) {" +
  "  if (specifier.startsWith('.') && !specifier.endsWith('.ts')) {" +
  "   return nextResolve(specifier + '.ts', context);" +
  "  }" +
  "  throw error;" +
  " }" +
  "}";
register('data:text/javascript,' + encodeURIComponent(extensionResolver), import.meta.url);

const RECORD_COUNT = Number.parseInt(process.argv[2] ?? '10000', 10);
const BUCKET_COUNT = Number.parseInt(process.argv[3] ?? '200', 10);
const QUERY_COUNT = Number.parseInt(process.argv[4] ?? '2000', 10);
const K = 8;
const SIMILARITY_THRESHOLD = 0.3;
const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
const WARMUP_QUERIES = 200;
const TOKEN_VOCAB = 400;
const TOKENS_PER_RECORD = 12;
const TOKENS_PER_QUERY = 10;
const TARGET_P95_MS = 5;

/** Deterministic 32-bit PRNG (mulberry32); the constant is the corpus seed. */
function createRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, max) {
  return Math.floor(rng() * max);
}

const { createMemoryExperienceStore } = await import('../src/jitrl/stores/memory.store.ts');

const rng = createRng(0x5eed);
const LEVELS = ['meta', 'proposal', 'host_tool'];

// Bucket vocabularies make same-bucket records genuinely similar, so the exact
// pre-filter has real work to do instead of degenerating into noise.
const bucketTokens = [];
for (let bucket = 0; bucket < BUCKET_COUNT; bucket += 1) {
  const tokens = new Set(['bucket-' + String(bucket)]);
  while (tokens.size < 6) {
    tokens.add('v-' + String(pick(rng, TOKEN_VOCAB)));
  }
  bucketTokens.push([...tokens]);
}

function randomTokens(bucket, count) {
  const tokens = new Set(bucketTokens[bucket]);
  while (tokens.size < count) {
    tokens.add('v-' + String(pick(rng, TOKEN_VOCAB)));
  }
  return [...tokens].slice(0, count);
}

const baseTime = 1_700_000_000_000;
const records = [];
for (let index = 0; index < RECORD_COUNT; index += 1) {
  const bucket = index % BUCKET_COUNT;
  const level = LEVELS[index % LEVELS.length];
  records.push({
    id: 'bench-' + String(index),
    level,
    state: {
      level,
      bucket: 'task|b' + String(bucket),
      tokens: randomTokens(bucket, TOKENS_PER_RECORD),
      summary: 'synthetic state ' + String(index)
    },
    actionKey: 'action-' + String(index % 50),
    reward: rng() * 2 - 1,
    return: rng() * 4 - 1,
    rewardSources: { llm: rng(), tool: rng() },
    guidance: rng() < 0.5 ? 'memory' : 'guidance_free',
    policyId: 'policy-' + String(index % 7),
    sessionId: 'session-' + String(index % 11),
    createdAt: baseTime + index * 1000,
    redacted: true
  });
}

const store = createMemoryExperienceStore({
  now: () => baseTime + RECORD_COUNT * 1000 + 60_000,
  halfLifeMs: HALF_LIFE_MS
});

const buildStart = performance.now();
await store.append(records);
const buildMs = performance.now() - buildStart;

function makeQuery(index) {
  // 80% hit an existing bucket, 20% miss it and exercise the relaxation path.
  const miss = index % 5 === 0;
  const bucket = miss ? BUCKET_COUNT + (index % 7) : index % BUCKET_COUNT;
  const level = miss ? 'host_tool' : LEVELS[index % LEVELS.length];
  const tokens = miss
    ? ['bucket-' + String(bucket), 'v-' + String(pick(rng, TOKEN_VOCAB)), 'v-' + String(pick(rng, TOKEN_VOCAB))]
    : randomTokens(bucket, TOKENS_PER_QUERY);
  return {
    level,
    state: { level, bucket: 'task|b' + String(bucket), tokens, summary: 'bench query' },
    k: K,
    similarityThreshold: SIMILARITY_THRESHOLD
  };
}

const queries = [];
for (let index = 0; index < QUERY_COUNT; index += 1) {
  queries.push(makeQuery(index));
}

// Warmup: JIT and cache priming, excluded from the reported percentiles.
let sink = 0;
for (let index = 0; index < WARMUP_QUERIES; index += 1) {
  const query = queries[index % queries.length];
  sink += (await store.query(query)).length;
}

const durations = new Array(QUERY_COUNT);
for (let index = 0; index < QUERY_COUNT; index += 1) {
  const query = queries[index];
  const started = performance.now();
  const scored = await store.query(query);
  durations[index] = performance.now() - started;
  sink += scored.length;
}

function percentile(sorted, fraction) {
  const position = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return sorted[position];
}

const sorted = [...durations].sort((left, right) => left - right);
const mean = durations.reduce((total, value) => total + value, 0) / durations.length;
const report = {
  benchmark: 'jitrl-experience-store-query',
  node: process.version,
  records: RECORD_COUNT,
  buckets: BUCKET_COUNT,
  queries: QUERY_COUNT,
  k: K,
  similarityThreshold: SIMILARITY_THRESHOLD,
  buildMs: Number(buildMs.toFixed(3)),
  p50Ms: Number(percentile(sorted, 0.5).toFixed(4)),
  p95Ms: Number(percentile(sorted, 0.95).toFixed(4)),
  p99Ms: Number(percentile(sorted, 0.99).toFixed(4)),
  meanMs: Number(mean.toFixed(4)),
  maxMs: Number(sorted[sorted.length - 1].toFixed(4)),
  targetP95Ms: TARGET_P95_MS,
  totalScored: sink,
  storeSize: await store.size()
};

console.log(JSON.stringify(report, null, 2));

if (report.p95Ms >= TARGET_P95_MS) {
  console.error(
    'bench:jitrl FAILED: p95 ' + String(report.p95Ms) + 'ms >= target ' + String(TARGET_P95_MS) + 'ms'
  );
  process.exit(1);
}
