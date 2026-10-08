# Canvas rich-text corpus audit

Use this when a card description or Ancient label is absent in the Canvas stage and the
affected scene is unavailable. The audit feeds authored localization strings through
the **same tolerant parser** used by the Rust Canvas text preparation path.

```bash
# Audit every JSON table in a recovered English localization directory.
node scripts/audit-canvas-rich-text.mjs

# Audit the installed game's card, Ancient, event and modifier tables through a running host.
node scripts/audit-canvas-rich-text.mjs --host http://127.0.0.1:13337 --lang eng

# Audit previously extracted installed-game tables; --dir reads every JSON file there.
node scripts/audit-canvas-rich-text.mjs --dir .sts2/artifacts/beta-localization/eng
```

The default report is `.sts2/artifacts/canvas-rich-text-audit.json`. It records source
hashes, counts by category and tag, and the keys with parser losses or empty parsed
text. It does not copy game prose into the report. `withLosses` means styling was
flattened; `emptyAfterParse` is the direct check for a string disappearing during
rich-text parsing. A loss on an `authoredTemplate` may change after the game's
variables and branches are resolved.

Raw localization is a syntax corpus, not a rendered-scene census. Runtime card
variables, language fallback, option text generated for a particular Ancient page,
font readiness, text wrapping, clipping, and paint order need a live scene or a
marked repro recording. If `emptyAfterParse` stays zero, inspect that scene's
`__mirrorRendererDiagnostics().omissions.nodes` before attributing absent text to markup.
