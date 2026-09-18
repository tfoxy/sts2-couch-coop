function versionParts(version) {
  if (!/^\d+(?:\.\d+){1,2}$/.test(version ?? "")) return null;
  return version.split(".").map(Number);
}

function compareVersions(left, right) {
  const a = versionParts(left) ?? [];
  const b = versionParts(right) ?? [];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function selectIphone13Simulator(runtimesDocument, deviceTypesDocument, devicesDocument) {
  const runtimes = (runtimesDocument?.runtimes ?? [])
    .filter((runtime) => runtime?.isAvailable === true
      && /^iOS \d+(?:\.\d+){1,2}$/.test(runtime.name ?? "")
      && versionParts(runtime.version)
      && typeof runtime.identifier === "string")
    .sort((left, right) => compareVersions(right.version, left.version));
  const runtime = runtimes[0];
  if (!runtime) return { ok: false, reason: "stable-ios-runtime-unavailable" };

  const deviceType = (deviceTypesDocument?.devicetypes ?? [])
    .find((candidate) => candidate?.name === "iPhone 13" && typeof candidate.identifier === "string");
  if (!deviceType) return { ok: false, reason: "iphone-13-device-type-unavailable", runtime: runtime.identifier };

  const devices = devicesDocument?.devices?.[runtime.identifier] ?? [];
  // Names are user-editable in Simulator. Bind reuse to the exact device-type identifier so a renamed nearby
  // model can never satisfy an iPhone 13 run; an older inventory that omits the identifier simply takes the
  // deterministic create-and-delete path below.
  const existing = devices.find((candidate) => candidate?.isAvailable === true
    && candidate.deviceTypeIdentifier === deviceType.identifier
    && (candidate.state === "Booted" || candidate.state === "Shutdown"));
  if (existing) {
    return {
      ok: true,
      action: "reuse",
      runtime: runtime.identifier,
      runtimeVersion: runtime.version,
      deviceType: deviceType.identifier,
      udid: existing.udid,
      wasBooted: existing.state === "Booted",
      cleanup: existing.state === "Booted" ? "none" : "shutdown",
    };
  }
  return {
    ok: true,
    action: "create",
    runtime: runtime.identifier,
    runtimeVersion: runtime.version,
    deviceType: deviceType.identifier,
    wasBooted: false,
    cleanup: "delete",
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFile } = await import("node:fs/promises");
  const argumentsByName = Object.fromEntries(process.argv.slice(2).reduce((result, value, index, all) => {
    if (value.startsWith("--")) result.push([value.slice(2), all[index + 1]]);
    return result;
  }, []));
  if (!argumentsByName.runtimes || !argumentsByName.deviceTypes || !argumentsByName.devices) {
    process.stderr.write("requires --runtimes PATH --deviceTypes PATH --devices PATH\n");
    process.exit(64);
  }
  const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
  const result = selectIphone13Simulator(
    await readJson(argumentsByName.runtimes),
    await readJson(argumentsByName.deviceTypes),
    await readJson(argumentsByName.devices),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 78;
}
