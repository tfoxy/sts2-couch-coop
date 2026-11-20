#!/usr/bin/env bash
# Synthetic Cargo graphs: no registry, toolchain or game required.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/gsw/experiments/render-stream/rs-net"
touch "$work/gsw/experiments/render-stream/rs-net/Cargo.toml"
cat > "$work/bin/cargo" <<'PY'
#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
work = Path(os.environ['LICENSE_TEST_WORK'])
args = sys.argv[1:]
target = args[args.index('--filter-platform') + 1]
features = ['--features', 'rtc'] if '--features' in args else []
assert args == ['metadata', '--format-version', '1', '--locked', '--offline', '--filter-platform', target,
                *features, '--manifest-path', str(work / 'gsw/experiments/render-stream/rs-net/Cargo.toml')]
with (work / 'calls').open('a') as calls:
    calls.write(target + (' rtc' if features else '') + '\n')
print((work / (target + ('-rtc' if features else '') + '.json')).read_text())
PY
chmod +x "$work/bin/cargo"
python3 -I - "$work" <<'PY'
import json, sys
from pathlib import Path
work = Path(sys.argv[1])
for target in ('x86_64-unknown-linux-gnu', 'x86_64-pc-windows-gnullvm',
               'aarch64-apple-darwin', 'x86_64-apple-darwin'):
    packages, nodes = [], []
    def package(name, version='1.0.0', deps=()):
        directory = work / 'crates' / f'{name}-{version}'
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'LICENSE-MIT').write_text(f'licence text for {name} {version}\n')
        # Distinct metadata IDs across targets still describe the same shared crate.
        identity = f'{target}:{name}@{version}'
        packages.append(dict(id=identity, name=name, version=version, license='MIT',
                             manifest_path=str(directory / 'Cargo.toml')))
        nodes.append(dict(id=identity, deps=[dict(pkg=pkg, dep_kinds=[dict(kind=k) for k in kinds])
                                             for pkg, kinds in deps]))
        return identity
    dev_child = package('dev-child')
    build_child = package('build-child')
    dev = package('dev-only', deps=[(dev_child, [None])])
    build = package('build-only', deps=[(build_child, [None])])
    transitive = package('transitive')
    shared = package('shared', deps=[(transitive, [None]), (dev, ['dev']), (build, ['build'])])
    mixed = package('mixed-kind')
    windows_child = package('windows-child')
    windows = package('windows-only', deps=[(windows_child, [None])])
    linux = package('linux-only')
    deps = [(shared, [None]), (mixed, ['build', None]), (dev, ['dev']), (build, ['build'])]
    if target == 'x86_64-pc-windows-gnullvm':
        deps += [(windows, [None]), (package('shared', '2.0.0'), [None])]
    elif target == 'x86_64-unknown-linux-gnu':
        deps += [(linux, [None])]
    else:
        apple = package('security-framework', deps=[
            (package(name), [None]) for name in
            ('bitflags', 'core-foundation', 'core-foundation-sys', 'security-framework-sys')])
        deps += [(apple, [None]), (package(target + '-only'), [None])]
    root = package('render-stream-net', deps=deps)
    (work / (target + '.json')).write_text(json.dumps(dict(packages=packages, resolve=dict(root=root, nodes=nodes))))
    # The same graph with the optional WebRTC feature on: one more normal dependency of the root.
    rtc_packages, rtc_nodes = list(packages), [n for n in nodes if n['id'] != root]
    packages, nodes = rtc_packages, rtc_nodes
    rtc_root = package('render-stream-net', deps=deps + [(package('rtc-only'), [None])])
    (work / (target + '-rtc.json')).write_text(json.dumps(
        dict(packages=[p for p in packages if p['id'] != root or p is packages[-1]],
             resolve=dict(root=rtc_root, nodes=nodes))))
PY
LICENSE_TEST_WORK="$work" PATH="$work/bin:$PATH" \
  python3 -I "$here/render-capture-net-licenses.py" "$work/gsw" "$work/out"
python3 -I - "$work" <<'PY'
import csv, sys
from pathlib import Path
work = Path(sys.argv[1])
out = work / 'out'
with (out / 'manifest.tsv').open() as manifest:
    rows = list(csv.DictReader(manifest, delimiter='\t'))
checks = 0
def check(condition, message):
    global checks
    assert condition, message
    checks += 1
pairs = [(r['crate'], r['version']) for r in rows]
check(('windows-only', '1.0.0') in pairs, 'Windows-only crate omitted')
check(('windows-child', '1.0.0') in pairs, 'Windows transitive crate omitted')
check(('linux-only', '1.0.0') in pairs, 'Linux-only crate omitted')
check(pairs.count(('shared', '1.0.0')) == 1, 'shared crate not deduplicated')
check(('shared', '2.0.0') in pairs, 'different version wrongly deduplicated')
check(('transitive', '1.0.0') in pairs, 'normal transitive crate omitted')
check(('mixed-kind', '1.0.0') in pairs, 'normal edge with build kind omitted')
check(not {'dev-only', 'build-only', 'dev-child', 'build-child', 'render-stream-net'} & {p[0] for p in pairs},
      'root or dev/build dependency graph leaked into bundle')
check(pairs == sorted(set(pairs)), 'manifest is not sorted and unique')
check({p.name for p in out.iterdir()} == {'manifest.tsv', 'THIRD_PARTY_NOTICES.md'} |
      {r['license_filename'] for r in rows}, 'bundle layout changed')
check(all((out / r['license_filename']).read_text() ==
          f"==> {r['crate']} {r['version']}: LICENSE-MIT <==\n\nlicence text for {r['crate']} {r['version']}\n"
          for r in rows), 'licence text missing or changed')
check((work / 'calls').read_text().splitlines() ==
      ['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-gnullvm'], 'wrong target metadata calls')
notice = (out / 'THIRD_PARTY_NOTICES.md').read_text()
check(all(t in notice for t in ['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-gnullvm',
                              'render-capture/linux/librender_stream_net.so',
                              'render-capture/windows/render_stream_net.dll']), 'notice omits shipped targets')
print(f'render capture net licences: {checks} checks passed')
PY
LICENSE_TEST_WORK="$work" PATH="$work/bin:$PATH" \
  python3 -I "$here/render-capture-net-licenses.py" "$work/gsw" "$work/out-macos" --macos
python3 -I - "$work" <<'PY'
import csv, sys
from pathlib import Path
work = Path(sys.argv[1])
out = work / 'out-macos'
with (out / 'manifest.tsv').open() as manifest:
    rows = {r['crate']: r for r in csv.DictReader(manifest, delimiter='\t')}
apple = ('bitflags', 'core-foundation', 'core-foundation-sys', 'security-framework',
         'security-framework-sys', 'aarch64-apple-darwin-only', 'x86_64-apple-darwin-only')
for name in apple:
    assert name in rows, f'Apple-only dependency missing: {name}'
    assert f'licence text for {name} 1.0.0\n' in (out / rows[name]['license_filename']).read_text()
    assert name not in (work / 'out/manifest.tsv').read_text(), 'Apple dependency added without macOS'
assert (work / 'calls').read_text().splitlines()[2:] == [
    'x86_64-unknown-linux-gnu', 'x86_64-pc-windows-gnullvm', 'aarch64-apple-darwin', 'x86_64-apple-darwin']
notice = (out / 'THIRD_PARTY_NOTICES.md').read_text()
assert all(t in notice for t in ('aarch64-apple-darwin', 'x86_64-apple-darwin',
                                'render-capture/macos/librender_stream_net.dylib'))
print('render capture macOS net licences: 23 checks passed')
PY
printf '[features]\nrtc = ["dep:rtc-only"]\n' > "$work/gsw/experiments/render-stream/rs-net/Cargo.toml"
LICENSE_TEST_WORK="$work" PATH="$work/bin:$PATH" \
  python3 -I "$here/render-capture-net-licenses.py" "$work/gsw" "$work/out-rtc"
python3 -I - "$work" <<'PY'
import csv, sys
from pathlib import Path
work = Path(sys.argv[1])
with (work / 'out-rtc' / 'manifest.tsv').open() as manifest:
    rows = {r['crate'] for r in csv.DictReader(manifest, delimiter='\t')}
assert 'rtc-only' in rows, 'rtc feature dependency missing when rs-net declares the feature'
assert 'rtc-only' not in (work / 'out/manifest.tsv').read_text(), 'rtc dependency added without the feature'
assert (work / 'calls').read_text().splitlines()[6:] == [
    'x86_64-unknown-linux-gnu rtc', 'x86_64-pc-windows-gnullvm rtc'], 'rtc feature not requested'
print('render capture rtc net licences: 3 checks passed')
PY
