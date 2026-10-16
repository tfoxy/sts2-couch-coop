# Host setup layout fixture

A standalone Godot 4.5.1 .NET project. It loads no game, mod installation, certificate service,
or private game assets. The progress strip, structured help, layout geometry, platform icons,
and localized copy are source-linked from production. Font and button styling use stock Godot
substitutes; this is not proof of the complete in-game dialog or its controller integration.

Build with deployment disabled, then run using a Godot **.NET** executable:

```sh
COUCHCOOP_GAME_MODS_DIR=/tmp/cc-mods-host-ui-fixture \
  dotnet build tests/CouchCoop.HostUi.GodotFixture -p:CouchCoopBuildToLocalMods=false
"$GODOT_MONO" --headless --path tests/CouchCoop.HostUi.GodotFixture
```

Success exits zero and prints `HOST_UI_GODOT_FIXTURE_PASS`. It checks both 1920×1080 and
1280×800, all 14 catalogs, resolved progress bounds after zero-width initialization and text
wrapping, repeated help expansion/scrolling, bold headings, icon input pass-through, button-center
activation, surrounding-space nonactivation, and keyboard acceptance on stock controls.

For rendered evidence, use a private `gamescope --backend headless` compositor following
`docs/agents/qa-recipes.md` §2.x. Remove inherited desktop display routes, verify compositor/GPU
and private window ownership, and supervise process lifetime. Run the fixture without Godot's
`--headless` and append `-- --shots-dir <scratch-directory>`. Never use the desktop or Xvfb.
The screenshot option requires a rendering display; do not combine it with Godot `--headless`.
Keep screenshots, runtime caches and logs out of git.
