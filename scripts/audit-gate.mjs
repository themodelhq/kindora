#!/usr/bin/env node
/**
 * KINDORA dependency audit gate (v1.0.4 §14).
 *
 * Runs `npm audit --omit=dev --json` for a package and FAILS (exit 1) when a
 * HIGH or CRITICAL advisory is present in production dependencies that is not
 * on the explicitly ACCEPTED list below.
 *
 * The accepted list mirrors docs/DEPENDENCY_SECURITY_REPORT.md §3 — each entry
 * is a documented, justified, non-exploitable-in-production risk with an
 * upgrade path. Adding an entry to this list REQUIRES a matching entry in the
 * dependency security report.
 *
 * Usage: node scripts/audit-gate.mjs <backend|frontend|workers>
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Accepted HIGH/CRITICAL advisories in production trees (documented accepted risks).
 * Key: GHSA id or advisory source name; value: reason reference.
 */
const ACCEPTED = new Map([
  [
    'GHSA-ggr8-5vv4-36mx',
    'deepmerge-ts stack exhaustion via prisma CLI (@prisma/config) — build tooling only, never shipped in the runtime artifact; fix arrives with prisma >= 7.11 (docs/DEPENDENCY_SECURITY_REPORT.md §3)',
  ],
]);

const pkg = process.argv[2];
if (!pkg || !['backend', 'frontend', 'workers'].includes(pkg)) {
  console.error('Usage: node scripts/audit-gate.mjs <backend|frontend|workers>');
  process.exit(2);
}

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', pkg);

let raw;
try {
  raw = execFileSync('npm', ['audit', '--omit=dev', '--json'], { cwd: pkgDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (err) {
  // npm audit exits non-zero when advisories exist — the JSON is still printed.
  raw = String(err.stdout ?? '');
  if (!raw.trim().startsWith('{')) {
    console.error(`audit-gate: npm audit failed to run for ${pkg}: ${err.message}`);
    process.exit(2);
  }
}

let data;
try {
  data = JSON.parse(raw);
} catch {
  console.error('audit-gate: could not parse npm audit output');
  process.exit(2);
}

const vulns = data.vulnerabilities ?? {};
// Collect every concrete advisory source (GHSA URL/title name) in the tree so
// chain nodes whose `via` is just another package name can still be resolved
// to their underlying advisory ids.
const advisorySources = new Set();
for (const v of Object.values(vulns)) {
  for (const via of v.via ?? []) {
    if (typeof via === 'object' && via.url) advisorySources.add(via.url);
  }
}
const violations = [];
const acceptedHits = [];

for (const [name, v] of Object.entries(vulns)) {
  if (!['high', 'critical'].includes(v.severity)) continue;
  const sources = (v.via ?? [])
    .map((via) => (typeof via === 'string' ? null : via.url ?? via.name))
    .filter(Boolean);
  // A chain node (via = dependency name) inherits the advisories of that
  // dependency — resolve them recursively through the vulnerability graph.
  const inherited = [];
  const seen = new Set([name]);
  const walk = (depName, depth) => {
    if (depth > 10 || seen.has(depName)) return;
    seen.add(depName);
    const dep = vulns[depName];
    if (!dep) return;
    for (const via of dep.via ?? []) {
      if (typeof via === 'object' && (via.url || via.name)) inherited.push(via.url ?? via.name);
      else if (typeof via === 'string') walk(via, depth + 1);
    }
  };
  (v.via ?? []).filter((via) => typeof via === 'string').forEach((depName) => walk(depName, 0));
  const allSources = [...sources, ...inherited];
  const accepted = allSources.some((src) => src && [...ACCEPTED.keys()].some((ghsa) => String(src).includes(ghsa)));
  if (accepted) {
    acceptedHits.push(`${name} (${allSources.join(', ')}) — ACCEPTED: ${[...ACCEPTED.values()].join(' ')}`);
  } else {
    violations.push(`${name} [${v.severity}] via ${allSources.join(', ') || '(unknown)'}`);
  }
}

console.log(`audit-gate[${pkg}]: production-tree high/critical advisories:`);
if (acceptedHits.length) {
  for (const hit of acceptedHits) console.log(`  DOCUMENTED-ACCEPTED: ${hit}`);
}
if (violations.length) {
  for (const v of violations) console.error(`  VIOLATION: ${v}`);
  console.error(`audit-gate[${pkg}]: FAIL — ${violations.length} unaccepted high/critical advisory(ies). Remediate or document in docs/DEPENDENCY_SECURITY_REPORT.md and scripts/audit-gate.mjs.`);
  process.exit(1);
}
console.log(`audit-gate[${pkg}]: PASS — no unaccepted high/critical advisories in production dependencies.`);
