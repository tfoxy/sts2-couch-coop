export function parseExtraChromeArgs(env = process.env) {
  if (env.COUCHCOOP_BENCH_CHROME_ARGS_JSON) {
    const args = JSON.parse(env.COUCHCOOP_BENCH_CHROME_ARGS_JSON);
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || !arg.startsWith('--')))
      throw new Error('COUCHCOOP_BENCH_CHROME_ARGS_JSON must be a JSON array of Chrome switches');
    return args;
  }
  return (env.COUCHCOOP_BENCH_CHROME_ARGS ?? '').split(/\s+/).filter(Boolean);
}
