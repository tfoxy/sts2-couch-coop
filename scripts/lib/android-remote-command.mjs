// adb `shell` joins multiple trailing arguments into a remote shell command.
// Supply one POSIX-quoted command string instead, while retaining execFileSync
// locally so no local shell sees benchmark input.
export function posixSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

export function androidRemoteCommand(argv) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error("androidRemoteCommand: need argv");
  return argv.map(posixSingleQuote).join(" ");
}
