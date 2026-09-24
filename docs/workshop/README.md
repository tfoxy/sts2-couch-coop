# Steam Workshop posts

The player-facing posts for the mod's Workshop discussion board live under
[`workshop/discussions/`](../../workshop/discussions/), next to the store description they are linked from, so
they are maintained with the code they describe rather than living only in a chat log. This folder keeps
the notes behind them: why each post is shaped the way it is, and what each claim was checked against.

**Nothing publishes from this repo.** Each English post is pasted into its discussion by hand, so a change
is not live until that happens. The live discussion URLs are in
[`workshop/discussions/discussions.json`](../../workshop/discussions/discussions.json). Update it when a
post is first published or moves; the render script and `scripts/test-workshop-discussions.sh` check
every link against it.

| post | notes | English post (Steam BBCode) |
| --- | --- | --- |
| "Can't connect from a phone? Read this first" | [phone-connection-troubleshooting.md](phone-connection-troubleshooting.md) | [english/phone-connection-troubleshooting.bbcode](../../workshop/discussions/english/phone-connection-troubleshooting.bbcode) |
| "Having a problem? Post it here" | [reporting-a-problem.md](reporting-a-problem.md) | [english/reporting-a-problem.bbcode](../../workshop/discussions/english/reporting-a-problem.bbcode) |

The two cross-link each other: the phone post sends non-connection problems to the reporting post, and
the reporting post sends "my phone can't reach the page at all" the other way. The store description links
both: the phone post at the end of Quick Start, the reporting post at the end of "This mod is in beta".

## Translations

Every other Steam language has a Markdown translation of both posts at
`workshop/discussions/<language>/<post>.md`, using the same language ids as `workshop/localizations/`. They
are **read on GitHub and never posted to Steam**, so there are two Steam threads instead of 28. Each
localized store description links its own language's two files; each English post links all 13.

- **Every translation opens with a notice** linking its English Steam discussion, asking readers to comment
  there and saying they do not need to write in English.
- **"Here" is adapted, not translated.** Where the English means "this thread", the translation names the
  Steam discussion and links it. Links between the two posts go to the sibling file in the same language
  folder.
- **On-screen strings are quoted from that language's catalogs**, never re-translated:
  `src/CouchCoop.Mod/Localization/Catalogs/couchcoop.<id>.json` for what the host game shows, and
  `frontend/src/i18n/` for what the phone shows. `scripts/test-workshop-discussions.sh` pins the three mod
  labels every post names, so a catalog change that strands a translation fails loudly.
- **Windows, browser and iOS menu paths use the names those products show in the language.**
- **Change an English post, update all 13 translations in the same commit.** A translation that lags the
  English is the stale-claim problem again, in a language the maintainer may not read.
- After editing, run `bash scripts/test-workshop-discussions.sh` and
  `bash scripts/test-render-workshop-localizations.sh`. Both only read the tree.

## House rules for every post here

- **A claim goes in a post only once something in the tree has been cited for it.** Each notes file carries a
  "what has been checked against the shipped build" table; add the row when you add the claim. Seven
  claims in the phone post had gone stale or had always been wrong precisely because they were written
  without one.
- **Mark what is unconfirmed.** A path derived from code but never seen on a real install is worth
  publishing, but it belongs in the file's "still unconfirmed" note so the next editor knows which
  lines are load-bearing guesses.
- **One person writes these.** First person singular throughout — never "we", "us", "our" or "the
  team". A plural voice implies a support rota that does not exist. This holds in every translation.
- **Say what a file contains before asking anyone to paste it.** These boards are public. Logs carry
  the poster's SteamID64 and their computer's user name, so both posts name that and offer a
  lines-only alternative rather than "attach the whole thing".
- **No game internals.** The same rule as the rest of the repo: resource paths and node names the mod
  genuinely needs are fine, transcribed game source and walkthroughs of the game's own logic are not.
