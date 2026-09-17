# Steam Workshop posts

The player-facing posts for the mod's Workshop discussion board, kept here so they are maintained with
the code they describe rather than living only in a chat log.

**Nothing publishes from this repo.** Each post is pasted into its discussion by hand, so a change here
is not live until that happens. Keep each post's live URL in the table below, and update it when a post
is first published.

| post | live discussion |
| --- | --- |
| [phone-connection-troubleshooting.md](phone-connection-troubleshooting.md) — "Can't connect from a phone? Read this first" | https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/ |
| [reporting-a-problem.md](reporting-a-problem.md) — "Having a problem? Post it here" | *not yet published* |

The two cross-link each other: the phone post sends non-connection problems to the reporting post, and
the reporting post sends "my phone can't reach the page at all" the other way. When the reporting post
is published, replace `PLACEHOLDER_REPORTING_URL` in the phone post with its real URL.

## House rules for every post here

- **A claim goes in a post only once something in the tree has been cited for it.** Each file carries a
  "what has been checked against the shipped build" table; add the row when you add the claim. Seven
  claims in the phone post had gone stale or had always been wrong precisely because they were written
  without one.
- **Mark what is unconfirmed.** A path derived from code but never seen on a real install is worth
  publishing, but it belongs in the file's "still unconfirmed" note so the next editor knows which
  lines are load-bearing guesses.
- **One person writes these.** First person singular throughout — never "we", "us", "our" or "the
  team". A plural voice implies a support rota that does not exist.
- **Say what a file contains before asking anyone to paste it.** These boards are public. Logs carry
  the poster's SteamID64 and their computer's user name, so both posts name that and offer a
  lines-only alternative rather than "attach the whole thing".
- **No game internals.** The same rule as the rest of the repo: resource paths and node names the mod
  genuinely needs are fine, transcribed game source and walkthroughs of the game's own logic are not.
