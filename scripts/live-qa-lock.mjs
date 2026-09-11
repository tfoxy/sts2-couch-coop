#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULTS = Object.freeze({
  leaseRoot: process.env.COUCHCOOP_LIVEQA_LEASE_ROOT ?? "/tmp/couchcoop-liveqa.leases",
  guardDir: process.env.COUCHCOOP_LIVEQA_REGISTRY_GUARD ?? "/tmp/couchcoop-liveqa.registry.lock.d"
});

function fail(message, code = 2) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function safePart(value) {
  return encodeURIComponent(value).replaceAll("%", "_");
}

function leasePath(config, owner, pid) {
  return join(config.leaseRoot, `${safePart(owner)}-${pid}.json`);
}

function alive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withGuard(config, action) {
  const deadline = Date.now() + 3000;
  while (true) {
    try { mkdirSync(config.guardDir); break; }
    catch (error) {
      if (error?.code !== "EEXIST" || Date.now() >= deadline) fail(`live-QA registry is busy: ${config.guardDir}`);
      sleep(20);
    }
  }
  try { return action(); }
  finally { rmSync(config.guardDir, { recursive: true, force: true }); }
}

function parseResource(text) {
  const split = text.indexOf(":");
  const mode = split < 0 ? "exclusive" : text.slice(0, split);
  const name = split < 0 ? text : text.slice(split + 1);
  if ((mode !== "shared" && mode !== "exclusive") || !name || /\s/.test(name)) {
    fail(`invalid resource '${text}'; expected shared:<name> or exclusive:<name>`);
  }
  if (name === "global") {
    fail("global is not a live-QA resource; acquire the named resources the operation touches");
  }
  return { name, mode };
}

function canonicalResources(values) {
  const byName = new Map();
  for (const value of values) {
    const resource = typeof value === "string" ? parseResource(value) : value;
    const prior = byName.get(resource.name);
    if (!prior || resource.mode === "exclusive") byName.set(resource.name, resource);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function readLeases(config) {
  if (!existsSync(config.leaseRoot)) return [];
  const leases = [];
  for (const file of readdirSync(config.leaseRoot).filter((name) => name.endsWith(".json")).sort()) {
    try {
      const data = JSON.parse(readFileSync(join(config.leaseRoot, file), "utf8"));
      if (data && typeof data.owner === "string" && Number.isInteger(data.pid) && Array.isArray(data.resources)) {
        leases.push({ ...data, file: join(config.leaseRoot, file), alive: alive(data.pid) });
      }
    } catch (error) {
      fail(`invalid live-QA lease ${file}: ${error.message}`);
    }
  }
  return leases;
}

function resourcesConflict(a, b) {
  return a.name === b.name && (a.mode === "exclusive" || b.mode === "exclusive");
}

export function acquireLease({ owner, pid = process.pid, resources, config = DEFAULTS }) {
  if (!owner || /\s/.test(owner)) fail("--owner is required and may not contain whitespace");
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) fail("--pid must be a positive integer");
  const wanted = canonicalResources(resources ?? []);
  if (wanted.length === 0) fail("at least one --resource is required");
  return withGuard(config, () => {
    mkdirSync(config.leaseRoot, { recursive: true });
    const target = leasePath(config, owner, Number(pid));
    const others = readLeases(config).filter((lease) => lease.file !== target);
    for (const lease of others) {
      for (const have of lease.resources) {
        for (const want of wanted) {
          if (resourcesConflict(have, want)) {
            fail(`${want.mode}:${want.name} conflicts with ${lease.owner} (${lease.pid}) holding ${have.mode}:${have.name}`);
          }
        }
      }
    }
    const prior = existsSync(target) ? JSON.parse(readFileSync(target, "utf8")) : null;
    if (prior && (prior.owner !== owner || prior.pid !== Number(pid))) {
      fail(`live-QA lease ownership mismatch at ${target}`);
    }
    const merged = canonicalResources([...(prior?.resources ?? []), ...wanted]);
    const lease = {
      version: 1,
      owner,
      pid: Number(pid),
      acquiredAt: prior?.acquiredAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      resources: merged
    };
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(lease, null, 2)}\n`, { flag: "wx" });
    renameSync(temp, target);
    return lease;
  });
}

export function assertLease({ owner, pid = process.pid, resources, config = DEFAULTS }) {
  const wanted = canonicalResources(resources ?? []);
  const file = leasePath(config, owner, Number(pid));
  if (!existsSync(file)) fail(`no live-QA lease for ${owner} (${pid})`);
  const lease = JSON.parse(readFileSync(file, "utf8"));
  if (lease.owner !== owner || lease.pid !== Number(pid)) fail("live-QA lease ownership mismatch");
  for (const want of wanted) {
    const have = lease.resources.find((resource) => resource.name === want.name);
    if (!have || (want.mode === "exclusive" && have.mode !== "exclusive")) {
      fail(`lease ${owner} (${pid}) does not hold ${want.mode}:${want.name}`);
    }
  }
  return lease;
}

export function releaseLease({ owner, pid = process.pid, config = DEFAULTS }) {
  return withGuard(config, () => {
    const file = leasePath(config, owner, Number(pid));
    if (!existsSync(file)) fail(`no live-QA lease for ${owner} (${pid})`);
    const lease = JSON.parse(readFileSync(file, "utf8"));
    if (lease.owner !== owner || lease.pid !== Number(pid)) fail("live-QA lease ownership mismatch");
    rmSync(file);
    if (existsSync(config.leaseRoot) && readdirSync(config.leaseRoot).length === 0) {
      rmSync(config.leaseRoot, { recursive: true });
    }
    return lease;
  });
}

export function listLeases(config = DEFAULTS) {
  return { leases: readLeases(config) };
}

function parseArgs(argv) {
  const result = { resources: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") { result.command = argv.slice(i + 1); break; }
    if (!arg.startsWith("--")) fail(`unexpected argument ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[++i];
    if (value === undefined) fail(`${arg} needs a value`);
    if (key === "resource") result.resources.push(value);
    else result[key] = value;
  }
  return result;
}

function configFrom(args) {
  return {
    leaseRoot: args.leaseRoot ?? DEFAULTS.leaseRoot,
    guardDir: args.guardDir ?? DEFAULTS.guardDir
  };
}

export function runCli(argv = process.argv.slice(2)) {
  const command = argv[0];
  const args = parseArgs(argv.slice(1));
  const config = configFrom(args);
  const owner = args.owner ?? process.env.COUCHCOOP_LIVEQA_OWNER;
  const pid = Number(args.pid ?? process.env.COUCHCOOP_LIVEQA_PID ?? process.pid);
  if (command === "list") {
    const current = listLeases(config);
    for (const lease of current.leases) {
      console.log(`${lease.owner} ${lease.pid} ${lease.alive ? "alive" : "dead"} ${lease.resources.map((r) => `${r.mode}:${r.name}`).join(" ")}`);
    }
    return 0;
  }
  if (command === "acquire") {
    const lease = acquireLease({ owner, pid, resources: args.resources, config });
    console.log(`${lease.owner} ${lease.pid} ${lease.resources.map((r) => `${r.mode}:${r.name}`).join(" ")}`);
    return 0;
  }
  if (command === "assert") {
    assertLease({ owner, pid, resources: args.resources, config });
    return 0;
  }
  if (command === "release") {
    releaseLease({ owner, pid, config });
    return 0;
  }
  if (command === "with") {
    if (!args.command?.length) fail("with requires -- <command> [args...]");
    acquireLease({ owner, pid: process.pid, resources: args.resources, config });
    try {
      const child = spawnSync(args.command[0], args.command.slice(1), {
        stdio: "inherit",
        env: { ...process.env, COUCHCOOP_LIVEQA_OWNER: owner, COUCHCOOP_LIVEQA_PID: String(process.pid) }
      });
      if (child.error) throw child.error;
      return child.status ?? 1;
    } finally {
      releaseLease({ owner, pid: process.pid, config });
    }
  }
  fail("usage: live-qa-lock.mjs acquire|assert|list|release|with [options]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = runCli(); }
  catch (error) {
    console.error(`[live-qa-lock] ${error.message}`);
    process.exitCode = error.exitCode ?? 1;
  }
}
