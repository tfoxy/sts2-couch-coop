#!/usr/bin/env python3
"""Write the licence bundle for the render-stream net module (librender_stream_net.so) a release ships.

The module is godot-scene-web's rs-net, a Rust cdylib that statically links its crates.io dependencies
(wtransport, quinn, rustls, ring, tokio, ...). godot-scene-web commits no licence bundle for it (unlike its MSDF
generator), so the release builds one from the same Cargo.lock the module was built from, in the MSDF bundle's
format so scripts/verify-release-archive.sh checks both the same way:

  manifest.tsv           crate, version, chosen_spdx (the crate's declared licence expression), license_filename
  <crate>-<version>.txt  every top-level LICENSE*/COPYING*/NOTICE* file of that crate, concatenated
  THIRD_PARTY_NOTICES.md what this is and how it was made

The crate set is the normal (non-dev, non-build) dependency graph of `render-stream-net` for
x86_64-unknown-linux-gnu, read offline with `cargo metadata --locked`; procedural macros are included
conservatively. A crate whose package ships no licence file gets its declared licence's standard text (MIT where
the expression offers it), with the authors Cargo.toml names as the copyright holders, and the notice lists it.

usage: scripts/render-capture-net-licenses.py <godot-scene-web root> <output dir>
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

TARGET = "x86_64-unknown-linux-gnu"
LICENSE_FILE = re.compile(r"^(licen[cs]e|copying|notice)", re.IGNORECASE)
MIT_TEXT = """Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
"""


def normalize_spdx(expression: str) -> str:
    # Cargo's legacy "A/B" spelling means "A OR B".
    return " OR ".join(part.strip() for part in expression.split("/")) if "/" in expression else expression.strip()


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    gsw = Path(sys.argv[1]).resolve()
    out = Path(sys.argv[2])
    manifest_path = gsw / "experiments/render-stream/rs-net/Cargo.toml"
    metadata = json.loads(subprocess.run(
        ["cargo", "metadata", "--format-version", "1", "--locked", "--offline", "--filter-platform", TARGET,
         "--manifest-path", str(manifest_path)],
        check=True, capture_output=True, text=True).stdout)
    packages = {p["id"]: p for p in metadata["packages"]}
    nodes = {n["id"]: n for n in metadata["resolve"]["nodes"]}
    root = metadata["resolve"]["root"]
    if packages[root]["name"] != "render-stream-net":
        print(f"unexpected root package {packages[root]['name']}", file=sys.stderr)
        return 1

    reached, stack = set(), [root]
    while stack:
        node = stack.pop()
        if node in reached:
            continue
        reached.add(node)
        for dep in nodes[node]["deps"]:
            if any(kind["kind"] is None for kind in dep["dep_kinds"]):
                stack.append(dep["pkg"])
    reached.discard(root)

    out.mkdir(parents=True, exist_ok=True)
    rows, synthesized = [], []
    for pkg in sorted((packages[i] for i in reached), key=lambda p: (p["name"], p["version"])):
        name, version = pkg["name"], pkg["version"]
        declared = pkg.get("license")
        if not declared:
            print(f"{name} {version} declares no licence expression", file=sys.stderr)
            return 1
        spdx = normalize_spdx(declared)
        directory = Path(pkg["manifest_path"]).parent
        files = sorted(f for f in os.listdir(directory) if LICENSE_FILE.match(f) and (directory / f).is_file())
        filename = f"{name}-{version}.txt"
        parts = []
        if files:
            for f in files:
                parts.append(f"==> {name} {version}: {f} <==\n\n{(directory / f).read_text(encoding='utf-8', errors='replace').rstrip()}\n")
        else:
            if not re.search(r"\bMIT\b", spdx):
                print(f"{name} {version} ships no licence file and its expression ({spdx}) offers no MIT text", file=sys.stderr)
                return 1
            authors = ", ".join(a.split("<")[0].strip() for a in pkg.get("authors") or []) or f"the {name} authors"
            parts.append(f"==> {name} {version}: MIT (declared: {spdx}; the package ships no licence file) <==\n\n"
                         f"Copyright (c) {authors}\n\n{MIT_TEXT}")
            synthesized.append(f"{name} {version}")
        (out / filename).write_text("\n".join(parts), encoding="utf-8")
        rows.append((name, version, spdx, filename))

    with open(out / "manifest.tsv", "w", encoding="utf-8") as tsv:
        tsv.write("crate\tversion\tchosen_spdx\tlicense_filename\n")
        for row in rows:
            tsv.write("\t".join(row) + "\n")

    notice = [
        "# Render-stream net module third-party notices",
        "",
        "`render-capture/librender_stream_net.so` is godot-scene-web's `rs-net` (the WebTransport carrier and the",
        "TLS for wss of the new renderer's streaming seat), built from `experiments/render-stream/rs-net/Cargo.lock`.",
        f"It statically links the {len(rows)} third-party crates in `manifest.tsv`: the normal dependency graph of",
        f"`render-stream-net` for `{TARGET}`, procedural macros included conservatively. Each crate's",
        "`chosen_spdx` is the licence expression its Cargo.toml declares, and its `.txt` file carries every licence",
        "file of its package, copied from the crate source the module was built from.",
        "",
        "`wtransport` is built from a patched copy vendored in godot-scene-web",
        "(`rs-net/vendor/wtransport`, see `RENDER-STREAM-PATCH.md` there).",
    ]
    if synthesized:
        notice += [
            "",
            "These packages declare MIT (alone or as an option) but ship no licence file; their `.txt` gives the",
            "standard MIT text with the authors their Cargo.toml names: " + ", ".join(synthesized) + ".",
        ]
    (out / "THIRD_PARTY_NOTICES.md").write_text("\n".join(notice) + "\n", encoding="utf-8")
    print(f"render-capture net licences: {len(rows)} crates ({len(synthesized)} without a licence file) in {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
