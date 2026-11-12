# Third-party notices

CouchCoop release archives include the corresponding license texts under
`licenses/`. The release build derives the JavaScript dependency list from the
committed npm lockfile and fails if a production dependency has no license
file.

| Component | Version / revision | License |
| --- | --- | --- |
| spirectl | revision pinned in `release-dependencies.json` | Apache-2.0 (including NOTICE) |
| godot-scene-web | revision pinned in `release-dependencies.json` | MIT |
| QRCoder | 1.6.0 | MIT |
| Font Awesome Free brand SVG icons | 6.7.2 | CC BY 4.0 |
| DeviceDetector.NET | 6.5.2 | Apache-2.0 |
| LiteDB | 5.0.21 | MIT |
| Microsoft.Extensions.DependencyInjection.Abstractions | 10.0.10 | MIT |
| Microsoft.Extensions.Logging.Abstractions | 10.0.10 | MIT |
| System.Diagnostics.DiagnosticSource | 10.0.10 | MIT |
| YamlDotNet | 18.1.0 | MIT |
| Vue and `@vue/*` runtime packages | versions pinned in `frontend/package-lock.json` | MIT |
| vue-i18n and `@intlify/*` runtime packages | versions pinned in `frontend/package-lock.json` | MIT |
| Other npm production dependencies | versions pinned in `frontend/package-lock.json` | license shown in the lockfile and copied into the release license bundle |
| HarfBuzz (embedded WASM) | version recorded by godot-scene-web | Old MIT |
| Emscripten runtime portions (embedded WASM) | version recorded by godot-scene-web | MIT and University of Illinois/NCSA |
| Open Sans Semibold (embedded font) | artifact recorded by godot-scene-web | Apache-2.0 |
| MSDF generator Rust dependencies (runtime WASM) | versions pinned in godot-scene-web `packages/canvas/msdf-generator/Cargo.lock` | per-crate terms in `licenses/msdf-generator/manifest.tsv`; full texts and notices beside it |
| Windows capture libc++, libc++abi, libunwind and compiler-rt (statically linked) | LLVM 20.1.8, revision `87f0227cb60147a26a1eeb4fb06e3b505e9c7261`, in llvm-mingw `20250709` | Apache-2.0 WITH LLVM-exception; full text in `licenses/render-capture/windows/llvm-mingw-LICENSE.txt` |
| Windows capture and net module mingw-w64 CRT headers, startup objects and static runtime libraries | mingw-w64 14.0.0 alpha, distributed in llvm-mingw `20250709` | notices and individual terms in `licenses/render-capture/windows/mingw-w64-runtime-COPYING.txt` |
| Windows net module Rust standard library (statically linked) | Rust 1.95.0, revision `59807616e`, target `x86_64-pc-windows-gnullvm` | MIT OR Apache-2.0 (MIT selected); full text in `licenses/render-capture/windows/rust-std-MIT.txt` |

The Windows toolchain is llvm-mingw release `20250709`, asset
`llvm-mingw-20250709-ucrt-ubuntu-22.04-x86_64.tar.xz`, SHA-256
`60cafae6474c7411174cff1d4ba21a8e46cadbaeb05a1bace306add301628337`, from
<https://github.com/mstorsjo/llvm-mingw/releases/tag/20250709>. The LLVM licence text is
copied unchanged from its `LICENSE.TXT`. The committed mingw-w64 runtime notice is
copied unchanged from that asset's
`x86_64-w64-mingw32/share/mingw32/COPYING.MinGW-w64-runtime.txt` (revision: llvm-mingw
`20250709` distribution; upstream source
<https://github.com/mingw-w64/mingw-w64/blob/master/COPYING.MinGW-w64-runtime.txt>).
The Rust MIT text is copied unchanged from the matching Rust toolchain's
`share/doc/rust/licenses/MIT.txt`; source revision
<https://github.com/rust-lang/rust/tree/59807616e>.
The net module's other Rust dependencies use the versions and per-crate licence texts in
`licenses/render-capture/net/manifest.tsv`. Release `build-info.txt` records the actual
llvm-mingw object, Rust compiler version and Rust target used for that archive.

Slay the Spire 2, Godot, Spine, and FMOD names are used only for
identification/interoperability as described in `NOTICE`. No game assembly or
game asset is included in a CouchCoop release.

## Platform icons

The HTTPS device guide uses the Apple, Android, Windows, Linux, and Firefox Browser
brand SVG icons from [Font Awesome Free 6.7.2](https://github.com/FortAwesome/Font-Awesome/tree/6.7.2/svgs/brands),
Copyright 2024 Fonticons, Inc., licensed under
[Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).
The original SVG files are bundled unchanged; the application recolors them for display.
Upstream notices and the full license are included in
`licenses/FontAwesome-Free-6.7.2-LICENSE.txt` and `licenses/FontAwesome-CC-BY-4.0.txt`.
Brand names and logos identify supported platforms and do not imply endorsement.
