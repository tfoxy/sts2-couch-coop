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
| Vue and `@vue/*` runtime packages | versions pinned in `frontend/package-lock.json` | MIT |
| vue-i18n and `@intlify/*` runtime packages | versions pinned in `frontend/package-lock.json` | MIT |
| Other npm production dependencies | versions pinned in `frontend/package-lock.json` | license shown in the lockfile and copied into the release license bundle |
| HarfBuzz (embedded WASM) | version recorded by godot-scene-web | Old MIT |
| Emscripten runtime portions (embedded WASM) | version recorded by godot-scene-web | MIT and University of Illinois/NCSA |
| Open Sans Semibold (embedded font) | artifact recorded by godot-scene-web | Apache-2.0 |

Slay the Spire 2, Godot, Spine, and FMOD names are used only for
identification/interoperability as described in `NOTICE`. No game assembly or
game asset is included in a CouchCoop release.
