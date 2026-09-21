export function parseRecordingArgs(argv) {
  const args = { duration: 25, out: null, staticBg: "off" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--duration") args.duration = Number(argv[++i]);
    else if (arg === "--out") {
      args.out = argv[++i];
      if (!args.out || args.out.startsWith("--")) throw new Error("--out requires a path");
    } else if (arg === "--static-bg") args.staticBg = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(args.duration) || args.duration <= 0) throw new Error(`Invalid --duration: ${args.duration}`);
  if (!["on", "off"].includes(args.staticBg)) throw new Error("--static-bg must be on or off");
  return args;
}

export function recordingWebSocketUrl(origin, staticBg) {
  if (!["on", "off"].includes(staticBg)) throw new Error("--static-bg must be on or off");
  return `${origin.replace(/\/$/, "")}/ws?watch=1&staticBg=${staticBg === "on" ? 1 : 0}&cardFlight=1&handTween=1&trailDrive=0`;
}
