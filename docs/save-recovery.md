# Support page — "CouchCoop overwrote my saves"

The recovery page players are pointed at when a CouchCoop version before **v0.2.3** overwrote their Steam
Cloud saves. Kept here so it is maintained with the code it describes. **It is linked, not pasted**: the
maintainer answers the Workshop comment with a link to this file on GitHub rather than opening a discussion
thread, because a thread titled after lost progress reads to every passing player as a recurring hazard.

## What went wrong, for the record

To give each browser player their own view of the game, the host launches extra game instances and gives
each one an isolated Godot `user://` (`src/CouchCoop.Mod/Session/HeadlessUserDirSeeder.cs`), seeded with a
copy of the host's `steam/<id>/` profile tree. Steam Remote Storage has no equivalent seam — it is addressed
by (Steam account, app id) — so those instances were writing their now-stale copy of the player's profile
into the player's own cloud storage, from outside the sandbox. The game's own startup sync then copies
cloud-over-local whenever the cloud stamp is newer, and deletes local files the cloud does not have.

`SeatCloudSaveIsolationPatch` (v0.2.3) closes every seat→cloud write and skips the seat's cloud sync, and
the seeder no longer hands a seat an in-progress run save. Affected releases: **v0.1.0 through v0.2.2**.

## What has been checked against the shipped build

| the page says | where it comes from |
| --- | --- |
| affected versions are v0.1.0 – v0.2.2 | `f02b7440` is an ancestor of `v0.2.3` and of no earlier tag |
| extra instances wrote into Steam Cloud | seat logs: `Wrote <n> bytes to modded/profile<N>/saves/progress.save in steam remote store` |
| the cloud copy comes back down over the local one | host log: `Copying modded/profile3/saves/progress.save from cloud to local. Local file exists: True Cloud save time: … Local save time: …` |
| local files missing from the cloud are deleted | host log: `Deleting modded/profile1/saves/current_run.save because it does not exist on remote` |
| rejected runs become `*.VAL.corrupt` | quarantined files present in the account's remote store |
| the mod's per-player snapshot path | `HeadlessUserDirSeeder.SlotBase` + `ResolvePolicy` (`couch-coop/headless-slots/slot-<N>/`) |
| what the snapshot contains | `HeadlessUserDirSeeder.SeedCopyDirs` = `default`, `mod_configs`, `steam` |
| the pre-session backup path and contents | `HostProfileBackup` (`couch-coop/save-backups/<utc stamp>/` holding `default/` + `steam/`), taken once per host session at the first join, three kept. Excludes in-progress run saves and `*.spirectl-backup-*`; **keeps** `*.VAL.corrupt` quarantines, because this page tells players those are still their save |
| Linux save + log paths | observed on a live Linux install |

**Unverified, and marked as such below:**

- The **Windows** and **macOS** save paths are derived from `HeadlessUserDirSeeder.ResolvePolicy` (`APPDATA`
  on Windows, `$HOME/Library/Application Support` on macOS) and from Godot's `use_custom_user_dir` handling.
  Neither has been seen on a real install, the same gap `phone-connection-troubleshooting.md` records for
  its Windows log path.
- The Steam **userdata** locations on Windows and macOS are the standard ones, not checked here.
- What Steam does when Cloud is switched back on (the "which version to keep" prompt) is general Steam
  behaviour, not something this repo has tested for this app.

---

## The page

### If CouchCoop overwrote your Slay the Spire 2 saves

This was a real bug in CouchCoop **v0.1.0 through v0.2.2**, and it is fixed in **v0.2.3** — update the mod
first. It only affected people who actually played with browser players; the mod does nothing to your saves
otherwise.

What happened: to give each phone or browser player their own view of the game, the mod launches extra
copies of the game on the host computer. Each gets its own isolated game folder — but **Steam Cloud is not
per-folder**, it belongs to your Steam account. So those extra copies were writing their older snapshot of
your profile into your cloud saves, and the next time you launched the game it pulled that snapshot back
down over your real profile. Files the cloud did not have were deleted locally to match.

Your progress is often still on your disk. Work through this before launching the game again.

#### 1. Stop the cloud copy from overwriting anything else

In Steam, right-click **Slay the Spire 2** → **Properties** → **General** → turn **Steam Cloud off** for
now. Leave it off until step 4.

#### 2. Make a copy of your save folder before you change anything

Your save folder is:

| | |
| --- | --- |
| Windows | `%APPDATA%\SlayTheSpire2` |
| Linux | `~/.local/share/SlayTheSpire2` |
| macOS | `~/Library/Application Support/SlayTheSpire2` |

Copy that whole folder somewhere safe. Everything below is reversible if you do.

#### 3. Find the best surviving copy of `progress.save`

Your live profile is at `steam\<your steam id>\modded\profile<N>\saves\` inside the folder above — `modded`
because you play with mods; an unmodded profile is at `steam\<your steam id>\profile<N>\saves\`. `<N>` is
1, 2 or 3, matching the profile slot you play on.

Five places a better copy may exist, best first:

- **The mod's own backup of your profile**, taken just before the first browser player of a session joins.
  This is the one to try first: it is a copy of your profile from *before* that session, and the mod keeps
  the last three. Versions after v0.2.3 make these; if you are on an older one the folder will not exist.
  - Windows `%APPDATA%\SlayTheSpire2\couch-coop\save-backups\<date and time>\steam\<your steam id>\modded\profile<N>\saves\`
  - Linux `~/.local/share/SlayTheSpire2/couch-coop/save-backups/<date and time>/steam/<your steam id>/modded/profile<N>/saves/`
  - macOS `~/Library/Application Support/SlayTheSpire2/couch-coop/save-backups/<date and time>/steam/<your steam id>/modded/profile<N>/saves/`

  The folder name is the date and time in UTC, newest last. The run you had in progress is deliberately not
  in there — `progress.save`, your settings, your past-run history and any quarantined `.VAL.corrupt` files are.
- **The mod's per-player snapshots.** Every time a browser player joined, the mod copied your profile into that
  player's folder. Look in:
  - Windows `%APPDATA%\SlayTheSpire2\couch-coop\headless-slots\slot-<N>\SlayTheSpire2\steam\<your steam id>\modded\profile<N>\saves\`
  - Linux `~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-<N>/SlayTheSpire2/steam/<your steam id>/modded/profile<N>/saves/`
  - macOS `~/Library/Application Support/SlayTheSpire2/couch-coop/headless-slots/slot-<N>/Library/Application Support/SlayTheSpire2/steam/<your steam id>/modded/profile<N>/saves/`

  There is one `slot-<N>` folder per player seat. Compare the `progress.save` files by **date and size** —
  a bigger file generally means more progress. Note that these snapshots are refreshed each time a player
  joins, so if you played more co-op after noticing the problem they may hold the damaged copy too.
- **The game's own backups.** Next to each save there is a `.backup` file — `progress.save.backup`.
- **Quarantined files.** The game renames a save it refuses to `<name>.<numbers>.VAL.corrupt`. That is still
  your save; renaming it back to `current_run_mp.save` (or `current_run.save`) is worth trying.
- **Steam's copy on disk**, at `userdata\<your account id>\2868840\remote\` inside your Steam folder —
  typically `C:\Program Files (x86)\Steam` on Windows, `~/.steam/steam` on Linux (some distributions use a
  different folder under `~/.steam`), `~/Library/Application Support/Steam` on macOS.

#### 4. Put it back

Copy the best `progress.save` you found into `steam\<your steam id>\modded\profile<N>\saves\`, start the
game with Steam Cloud still off, and check the profile.

Also look at `profile.save` — the small file at the top of `steam\<your steam id>\modded\` for modded play,
and a second one at the top of `steam\<your steam id>\`. It records which profile the game opens. Sometimes nothing was lost at all and the game is simply opening a different
profile slot than the one you played on; the other slots are worth checking from the game's own profile
screen before you conclude anything is gone.

When the game shows the right progress, turn Steam Cloud back on. If Steam asks which version to keep,
**keep the local one**.

#### If none of that turns anything up

Send the host computer's log — `logs\godot.log` inside the save folder from step 2 — and say which profile
slot you play on and roughly when you last saw your progress intact. Lines containing `steam remote store`
and `from cloud to local` are the ones that show what happened and when.
