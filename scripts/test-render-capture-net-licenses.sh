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
assert args == ['metadata', '--format-version', '1', '--locked', '--offline', '--filter-platform', target,
                '--manifest-path', str(work / 'gsw/experiments/render-stream/rs-net/Cargo.toml')]
with (work / 'calls').open('a') as calls:
    calls.write(target + '\n')
print((work / (target + '.json')).read_text())
PY
chmod +x "$work/bin/cargo"
python3 -I - "$work" <<'PY'
import json, sys
from pathlib import Path
work = Path(sys.argv[1])
for target in ('x86_64-unknown-linux-gnu', 'x86_64-pc-windows-gnullvm'):
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
    else:
        deps += [(linux, [None])]
    root = package('render-stream-net', deps=deps)
    (work / (target + '.json')).write_text(json.dumps(dict(packages=packages, resolve=dict(root=root, nodes=nodes))))
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
