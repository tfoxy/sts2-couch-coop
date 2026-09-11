#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { acquireLease, assertLease, listLeases, releaseLease } from "./live-qa-lock.mjs";

const root = mkdtempSync(join(tmpdir(), "couch-live-lock-test-"));
const config = {
  leaseRoot: join(root, "leases"),
  guardDir: join(root, "guard")
};

function rejects(fn, pattern) {
  assert.throws(fn, pattern);
}

try {
  acquireLease({ owner: "game-a", pid: 10101, resources: ["shared:install", "exclusive:game:a"], config });
  acquireLease({ owner: "phone-b", pid: 10102, resources: ["shared:install", "exclusive:android:serial-b", "exclusive:browser:9222"], config });
  assert.equal(listLeases(config).leases.length, 2, "disjoint sessions coexist");
  rejects(() => acquireLease({ owner: "wild", pid: 10109, resources: ["exclusive:global"], config }), /not a live-QA resource/);
  rejects(
    () => acquireLease({ owner: "same-game", pid: 10103, resources: ["exclusive:game:a"], config }),
    /conflicts with game-a/
  );
  assert.equal(listLeases(config).leases.some((lease) => lease.owner === "same-game"), false, "a conflicting multi-resource acquire writes nothing");
  rejects(
    () => acquireLease({ owner: "deploy", pid: 10104, resources: ["exclusive:install"], config }),
    /conflicts/
  );
  assertLease({ owner: "game-a", pid: 10101, resources: ["shared:install", "exclusive:game:a"], config });
  rejects(() => assertLease({ owner: "game-a", pid: 10101, resources: ["exclusive:install"], config }), /does not hold/);
  rejects(() => releaseLease({ owner: "game-a", pid: 999, config }), /no live-QA lease/);
  releaseLease({ owner: "game-a", pid: 10101, config });
  releaseLease({ owner: "phone-b", pid: 10102, config });

  acquireLease({ owner: "read-a", pid: 10105, resources: ["shared:game:default", "shared:install"], config });
  acquireLease({ owner: "read-b", pid: 10106, resources: ["shared:game:default", "shared:install"], config });
  rejects(() => acquireLease({ owner: "drive", pid: 10107, resources: ["exclusive:game:default"], config }), /conflicts/);
  releaseLease({ owner: "read-a", pid: 10105, config });
  releaseLease({ owner: "read-b", pid: 10106, config });

  acquireLease({ owner: "stale", pid: 99999999, resources: ["exclusive:game:stale"], config });
  assert.equal(listLeases(config).leases.find((lease) => lease.owner === "stale")?.alive, false);
  rejects(() => acquireLease({ owner: "stale-taker", pid: 10111, resources: ["shared:game:stale"], config }), /conflicts/);
  releaseLease({ owner: "stale", pid: 99999999, config });

  const wrapped = spawnSync(
    process.execPath,
    [new URL("./live-qa-lock.mjs", import.meta.url).pathname, "with", "--owner", "wrapped", "--resource", "shared:install", "--",
      process.execPath, "-e", "if (!process.env.COUCHCOOP_LIVEQA_OWNER || !process.env.COUCHCOOP_LIVEQA_PID) process.exit(9)"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        COUCHCOOP_LIVEQA_LEASE_ROOT: config.leaseRoot,
        COUCHCOOP_LIVEQA_REGISTRY_GUARD: config.guardDir
      }
    }
  );
  assert.equal(wrapped.status, 0, wrapped.stderr);
  assert.equal(listLeases(config).leases.length, 0, "with releases after its child exits");

  console.log("live-qa-lock: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
