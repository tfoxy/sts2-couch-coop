// Whole-browser, process, Inspector and LayerTree measurements are separate ledgers.
// Differences here describe avoidable costs under one workload, never additive ownership.
export const ABLATION_SCHEMA = "couchcoop-webkit-ablation/1";
export const LOCAL_MEMORY_BUDGET_BYTES = 1024 ** 3;
export const PEAK_METRICS = ["cgroupPeakBytes", "pssPeakBytes", "layerPeakBytes"];

const validNumber = value => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function compareReplicates(control, treatment) {
  if (!control.length || !treatment.length || ![...control, ...treatment].every(validNumber)) {
    return { measured: false, reason: "missing-or-invalid-metric" };
  }
  const range = values => Math.max(...values) - Math.min(...values);
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const separationBytes = Math.min(...control) - Math.max(...treatment);
  const driftBytes = Math.max(range(control), range(treatment));
  const repeated = control.length >= 2 && treatment.length >= 2;
  return {
    measured: true, repeated, control, treatment,
    meanReductionBytes: mean(control) - mean(treatment),
    separationBytes, driftBytes,
    repeatableReduction: repeated && separationBytes > 0 && separationBytes > driftBytes
  };
}

export function analyzeAblation(manifest) {
  if (manifest?.schema !== ABLATION_SCHEMA || !Array.isArray(manifest.legs) || !Array.isArray(manifest.comparisons)) {
    throw new Error(`expected ${ABLATION_SCHEMA} with legs and comparisons`);
  }
  const byId = new Map();
  for (const leg of manifest.legs) {
    if (typeof leg.id !== "string" || byId.has(leg.id)) throw new Error("missing or duplicate leg id");
    byId.set(leg.id, leg);
  }
  const comparisons = manifest.comparisons.map(comparison => {
    const errors = [];
    const ids = [...(comparison.controlIds ?? []), ...(comparison.treatmentIds ?? [])];
    if (!comparison.controlIds?.length || !comparison.treatmentIds?.length) errors.push("missing-arm");
    if (new Set(ids).size !== ids.length) errors.push("reused-leg-within-comparison");
    const selected = ids.map(id => {
      const leg = byId.get(id);
      if (!leg) errors.push(`missing-leg:${id}`);
      return leg;
    }).filter(Boolean);
    for (const leg of selected) {
      if (leg.measured !== true) errors.push(`unmeasured:${leg.id}`);
      if (leg.triggerValid !== true) errors.push(`invalid-trigger:${leg.id}`);
      if (!leg.workloadKey) errors.push(`missing-workload:${leg.id}`);
      if (!leg.processIdentity) errors.push(`missing-process-identity:${leg.id}`);
      for (const metric of [...PEAK_METRICS, "swapPeakBytes"]) {
        if (!validNumber(leg.metrics?.[metric])) errors.push(`missing-metric:${leg.id}:${metric}`);
      }
      if (!validNumber(leg.oomEvents) || !validNumber(leg.oomKillEvents)) errors.push(`missing-oom-events:${leg.id}`);
      else if (leg.oomEvents || leg.oomKillEvents) errors.push(`cgroup-oom:${leg.id}`);
      if (leg.targetReplaced !== false) errors.push(`target-continuity-unproved:${leg.id}`);
    }
    if (new Set(selected.map(leg => leg.workloadKey)).size > 1) errors.push("workload-mismatch");
    if (new Set(selected.map(leg => leg.processIdentity)).size !== selected.length) errors.push("browser-process-reused");
    const control = (comparison.controlIds ?? []).map(id => byId.get(id)).filter(Boolean);
    const treatment = (comparison.treatmentIds ?? []).map(id => byId.get(id)).filter(Boolean);
    const repeated = control.length >= 2 && treatment.length >= 2;
    const order = manifest.legs.filter(leg => ids.includes(leg.id))
      .map(leg => comparison.controlIds.includes(leg.id) ? "A" : "B").join("");
    if (repeated && order !== "ABBA") errors.push("confirmation-order-must-be-ABBA");
    const metrics = Object.fromEntries(PEAK_METRICS.map(metric => [metric,
      compareReplicates(control.map(leg => leg.metrics?.[metric]), treatment.map(leg => leg.metrics?.[metric]))
    ]));
    const budget = {
      limitBytes: LOCAL_MEMORY_BUDGET_BYTES,
      underLimit: treatment.length > 0 && treatment.every(leg =>
        validNumber(leg.metrics?.cgroupPeakBytes) && leg.metrics.cgroupPeakBytes < LOCAL_MEMORY_BUDGET_BYTES),
      zeroSwap: selected.length > 0 && selected.every(leg => leg.metrics?.swapPeakBytes === 0)
    };
    const measured = errors.length === 0;
    // The product budget and primary ranking concern the whole browser. Other ledgers can stay flat (for
    // example, a runtime-only reduction need not remove any layers), and retain their own repeatability verdict.
    const repeatableReduction = measured && metrics.cgroupPeakBytes.repeatableReduction;
    return {
      id: comparison.id, group: comparison.group ?? null,
      acceptance: comparison.acceptance === true, measured,
      status: !measured ? "invalid" : !repeated ? "exploratory" : repeatableReduction ? "repeatable-reduction" : "no-repeatable-reduction",
      errors, order, metrics, budget,
      accepted: comparison.acceptance === true ? repeatableReduction && budget.underLimit && budget.zeroSwap : null
    };
  });
  const rankedGroups = comparisons.filter(value => value.group && value.measured)
    .sort((a, b) => b.metrics.cgroupPeakBytes.meanReductionBytes - a.metrics.cgroupPeakBytes.meanReductionBytes)
    .map(value => ({ id: value.id, group: value.group, status: value.status,
      cgroupReductionBytes: value.metrics.cgroupPeakBytes.meanReductionBytes,
      pssReductionBytes: value.metrics.pssPeakBytes.meanReductionBytes,
      layerReductionBytes: value.metrics.layerPeakBytes.meanReductionBytes }));
  return {
    schema: ABLATION_SCHEMA, comparisons, rankedGroups,
    interpretation: "Avoidable differences under the recorded workload; metrics and group differences must not be added together."
  };
}

export function ablationMarkdown(result) {
  const mib = value => Number.isFinite(value) ? (value / 1024 ** 2).toFixed(2) : "unavailable";
  const clean = value => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
  const lines = ["# WebKit group attribution", "", result.interpretation, "",
    "Positive differences mean treatment used less memory. Exploratory rows have not established repeatability.", "",
    "| Comparison | Status | Cgroup reduction MiB | PSS reduction MiB | LayerTree reduction MiB | Acceptance |",
    "| --- | --- | ---: | ---: | ---: | --- |"];
  for (const row of result.comparisons) {
    lines.push(`| ${clean(row.id)} | ${row.status} | ${mib(row.measured ? row.metrics.cgroupPeakBytes.meanReductionBytes : null)} | ${mib(row.measured ? row.metrics.pssPeakBytes.meanReductionBytes : null)} | ${mib(row.measured ? row.metrics.layerPeakBytes.meanReductionBytes : null)} | ${row.accepted === null ? "diagnostic only" : row.accepted ? "pass" : "fail"} |`);
  }
  for (const row of result.comparisons.filter(value => value.errors.length)) lines.push("", `${clean(row.id)}: ${row.errors.map(clean).join(", ")}`);
  return `${lines.join("\n")}\n`;
}
