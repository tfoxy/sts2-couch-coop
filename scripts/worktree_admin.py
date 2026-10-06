#!/usr/bin/env python3
"""Inventory, prune, and relocate CouchCoop worktrees and known sibling bundles."""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


class AdminError(RuntimeError):
    pass


def git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if check and result.returncode:
        detail = result.stderr.strip() or result.stdout.strip()
        raise AdminError(f"git -C {repo} {' '.join(args)} failed: {detail}")
    return result


def canonical(path: Path) -> Path:
    return Path(os.path.abspath(path))


@dataclass
class Worktree:
    repo: Path
    path: Path
    head: str | None = None
    branch: str | None = None
    detached: bool = False
    locked: bool = False
    prunable: bool = False

    @property
    def label(self) -> str:
        state = f"branch={self.branch}" if self.branch else "detached"
        flags = []
        if self.locked:
            flags.append("locked")
        if self.prunable:
            flags.append("prunable")
        if not self.path.exists():
            flags.append("missing")
        if flags:
            state += "," + ",".join(flags)
        return f"{self.repo.name}:{self.path} [{state}]"


def list_worktrees(repo: Path) -> list[Worktree]:
    result = git(repo, "worktree", "list", "--porcelain")
    entries: list[Worktree] = []
    current: Worktree | None = None
    for line in (*result.stdout.splitlines(), ""):
        if not line:
            if current is not None:
                entries.append(current)
                current = None
            continue
        key, _, value = line.partition(" ")
        if key == "worktree":
            if current is not None:
                entries.append(current)
            current = Worktree(repo=repo, path=canonical(Path(value)))
        elif current is not None:
            if key == "HEAD":
                current.head = value
            elif key == "branch":
                current.branch = value.removeprefix("refs/heads/")
            elif key == "detached":
                current.detached = True
            elif key == "locked":
                current.locked = True
            elif key == "prunable":
                current.prunable = True
    return entries


def main_checkout(repo: Path) -> Path:
    matches = [wt for wt in list_worktrees(repo) if wt.branch == "main"]
    if len(matches) != 1:
        raise AdminError(f"expected exactly one local main checkout for {repo}, found {len(matches)}")
    return matches[0].path


def require_repo(path: Path, label: str) -> Path:
    if not path.is_dir():
        raise AdminError(f"missing {label} repository: {path}")
    top = Path(git(path, "rev-parse", "--show-toplevel").stdout.strip())
    if canonical(top) != canonical(path):
        raise AdminError(f"expected {label} repository root at {path}, found {top}")
    return canonical(path)


def repositories(couch_root: Path) -> dict[str, Path]:
    parent = couch_root.parent
    return {
        "sts2-couch-coop": require_repo(couch_root, "CouchCoop"),
        "spirectl": require_repo(parent / "spirectl", "spirectl"),
        "godot-scene-web": require_repo(parent / "godot-scene-web", "godot-scene-web"),
    }


def linked_couch_worktrees(repos: dict[str, Path]) -> list[Worktree]:
    primary = main_checkout(repos["sts2-couch-coop"])
    return [
        wt for wt in list_worktrees(repos["sts2-couch-coop"])
        if wt.path != primary
    ]


def match_sibling_worktrees(
    couch: Worktree,
    dependency_worktrees: dict[str, list[Worktree]],
) -> list[Worktree]:
    """Match only repo worktrees physically colocated beside a canonical CouchCoop folder."""
    if couch.path.name != "sts2-couch-coop":
        return []
    siblings: list[Worktree] = []
    for name in ("spirectl", "godot-scene-web"):
        expected = canonical(couch.path.parent / name)
        matches = [wt for wt in dependency_worktrees[name] if wt.path == expected]
        if len(matches) > 1:
            raise AdminError(f"ambiguous {name} worktrees alongside {couch.path}: {matches}")
        siblings.extend(matches)
    return siblings


def linked_dependency_worktrees(repos: dict[str, Path]) -> dict[str, list[Worktree]]:
    result: dict[str, list[Worktree]] = {}
    for name in ("spirectl", "godot-scene-web"):
        main = main_checkout(repos[name])
        result[name] = [wt for wt in list_worktrees(repos[name]) if wt.path != main]
    return result


def workspace_units(couch_worktrees: list[Worktree], repos: dict[str, Path]) -> list[list[Worktree]]:
    dependencies = linked_dependency_worktrees(repos)
    assigned: set[Path] = set()
    units: list[list[Worktree]] = []
    for couch in couch_worktrees:
        if couch.path in assigned:
            continue
        members = [couch, *match_sibling_worktrees(couch, dependencies)]
        assigned.update(member.path for member in members)
        units.append(members)
    return units


def checkout_state(wt: Worktree) -> tuple[bool, bool, str]:
    if wt.prunable or not wt.path.is_dir() or wt.head is None:
        return False, False, "missing/prunable"
    if wt.locked:
        return False, False, "locked"
    dirty = bool(git(wt.path, "status", "--porcelain", "--untracked-files=all").stdout)
    if dirty:
        return False, False, "dirty"
    merged = git(
        wt.repo,
        "merge-base",
        "--is-ancestor",
        wt.head,
        "refs/heads/main",
        check=False,
    ).returncode == 0
    return True, merged, "clean+merged" if merged else "clean+unmerged"


def assess_unit(unit: list[Worktree]) -> tuple[bool, list[tuple[Worktree, str]]]:
    states: list[tuple[Worktree, str]] = []
    eligible = True
    for wt in unit:
        clean, merged, reason = checkout_state(wt)
        if not clean or not merged:
            eligible = False
        states.append((wt, reason))
    return eligible, states


def format_unit(unit: list[Worktree], states: list[tuple[Worktree, str]], eligible: bool) -> None:
    title = " + ".join(wt.repo.name for wt in unit)
    print(f"  {'ELIGIBLE' if eligible else 'KEEP'} {title}")
    for wt, state in states:
        print(f"    {wt.label} — {state}")


def clean_empty_bundle(unit: list[Worktree], couch_root: Path) -> None:
    couch = next(wt for wt in unit if wt.repo.name == "sts2-couch-coop")
    workspace = couch.path.parent if couch.path.name == "sts2-couch-coop" else None
    if workspace is None:
        return
    worktrees_root = canonical(couch_root / ".worktrees")
    if not workspace.is_relative_to(worktrees_root) or not workspace.is_dir():
        return
    for dependency in ("spirectl", "godot-scene-web"):
        link = workspace / dependency
        if link.is_symlink() and os.readlink(link) == f"../{dependency}":
            link.unlink()
    try:
        workspace.rmdir()
    except OSError:
        pass


def prune(couch_root: Path, apply: bool) -> int:
    repos = repositories(couch_root)
    couch_worktrees = linked_couch_worktrees(repos)
    units = workspace_units(couch_worktrees, repos)
    print(f"CouchCoop linked worktrees: {len(couch_worktrees)}")
    print("Prune report (ignored files are preserved in dry-run and removed by --apply):")
    eligible_units: list[list[Worktree]] = []
    for unit in units:
        eligible, states = assess_unit(unit)
        format_unit(unit, states, eligible)
        if eligible:
            eligible_units.append(unit)
    print(f"Eligible workspaces: {len(eligible_units)} / {len(units)}")
    if not apply:
        print("Dry-run only. Pass --apply to remove eligible worktrees and merged branches.")
        return 0

    failures = 0
    for unit in eligible_units:
        # Recheck immediately before mutating, including every dependency in the bundle.
        eligible, _ = assess_unit(unit)
        if not eligible:
            print("KEEP changed since report: " + " + ".join(str(wt.path) for wt in unit))
            continue
        branches: list[tuple[Path, str]] = []
        # Remove dependencies first and CouchCoop last, all of which were checked clean/merged.
        for wt in sorted(unit, key=lambda member: member.repo.name == "sts2-couch-coop"):
            if wt.path.exists():
                result = git(wt.repo, "worktree", "remove", "--force", str(wt.path), check=False)
                if result.returncode:
                    print(f"ERROR removing {wt.path}: {result.stderr.strip()}")
                    failures += 1
                    break
                if wt.branch:
                    branches.append((wt.repo, wt.branch))
        else:
            for repo, branch in branches:
                result = git(repo, "branch", "-d", "--", branch, check=False)
                if result.returncode:
                    print(f"KEPT branch {repo.name}:{branch}: {result.stderr.strip()}")
                else:
                    print(f"removed branch {repo.name}:{branch}")
            clean_empty_bundle(unit, couch_root)
            print("removed workspace: " + " + ".join(str(wt.path) for wt in unit))
    print(f"Apply complete; removal errors: {failures}")
    return 1 if failures else 0


def shared_link(root: Path, dependency: str, target: Path, created: list[Path]) -> None:
    link = root / dependency
    if link.is_symlink():
        if canonical(link.resolve()) != canonical(target):
            raise AdminError(f"{link} points to {os.readlink(link)}, expected {target}")
        return
    if link.exists():
        raise AdminError(f"{link} exists and is not the expected relative symlink")
    link.symlink_to(os.path.relpath(target, root))
    created.append(link)


def migration_name(source: Path, worktrees_root: Path) -> Path:
    label_part = source.parent.name if source.name == "sts2-couch-coop" else source.name
    label = re.sub(r"[^A-Za-z0-9._-]+", "-", label_part).strip("-.") or "checkout"
    digest = hashlib.sha256(str(source).encode("utf-8")).hexdigest()[:10]
    base = f"legacy-{label}-{digest}"
    candidate = worktrees_root / base
    suffix = 2
    while candidate.exists() or candidate.is_symlink():
        candidate = worktrees_root / f"{base}-{suffix}"
        suffix += 1
    return candidate


@dataclass
class Migration:
    workspace: Path
    members: list[Worktree]
    destinations: dict[Path, Path]
    bundled: bool


def migration_plan(couch_root: Path, repos: dict[str, Path]) -> list[Migration]:
    worktrees_root = canonical(couch_root / ".worktrees")
    couch_worktrees = linked_couch_worktrees(repos)
    dependencies = linked_dependency_worktrees(repos)
    assigned: set[Path] = set()
    migrations: list[Migration] = []
    for couch in couch_worktrees:
        if couch.path.is_relative_to(worktrees_root):
            continue
        if couch.path in assigned:
            continue
        siblings = match_sibling_worktrees(couch, dependencies)
        members = [couch, *siblings]
        assigned.update(member.path for member in members)
        if any(wt.locked or wt.prunable or not wt.path.is_dir() for wt in members):
            print("AMBIGUOUS/UNMOVABLE; leaving entire workspace in place:")
            for wt in members:
                print(f"  {wt.label}")
            continue
        workspace = migration_name(couch.path, worktrees_root)
        bundled = bool(siblings)
        destinations = {
            couch.path: workspace / "sts2-couch-coop" if bundled else workspace,
        }
        for sibling in siblings:
            destinations[sibling.path] = workspace / sibling.repo.name
        if any(destination.exists() or destination.is_symlink() for destination in destinations.values()):
            raise AdminError(f"migration destination collision at {workspace}")
        migrations.append(Migration(workspace, members, destinations, bundled))
    return migrations


def checkout_setup_actions(wt: Worktree, couch_root: Path) -> list[str]:
    actions: list[str] = []
    for source, destination, label in (
        (couch_root / "sts2.local.yaml", wt.path / "sts2.local.yaml", "copy sts2.local.yaml"),
        (couch_root / "godot-client/.godot", wt.path / "godot-client/.godot", "copy Godot cache"),
    ):
        if source.exists() and not destination.exists():
            actions.append(label)

    source_modules = couch_root / "frontend/node_modules"
    destination_modules = wt.path / "frontend/node_modules"
    if source_modules.is_dir() and not destination_modules.exists():
        actions.append("link frontend/node_modules")
    source_ai = couch_root / ".ai"
    destination_ai = wt.path / ".ai"
    if source_ai.is_dir() and not destination_ai.exists():
        actions.append("link shared .ai")
    local_sts2 = wt.path / ".sts2"
    if (not local_sts2.exists() and not local_sts2.is_symlink()) or (
        local_sts2.is_symlink() and not local_sts2.exists()
    ):
        actions.append("create local .sts2")

    installer = wt.path / "scripts/install-agent-config.sh"
    codex_generator = wt.path / "scripts/gen-codex-config.py"
    agent_paths = (
        wt.path / ".claude/agents",
        wt.path / ".claude/skills",
        wt.path / ".agents/skills",
        wt.path / ".codex/config.toml",
        wt.path / ".codex/hooks.json",
    )
    if installer.is_file() and codex_generator.is_file() and any(not path.exists() for path in agent_paths):
        actions.append("install agent configuration")
    return actions


def setup_checkout(wt: Worktree, couch_root: Path) -> list[str]:
    """Fill missing local setup files without replacing existing checkout state."""
    completed: list[str] = []

    def copy_missing(source: Path, destination: Path, label: str) -> None:
        if destination.exists() or not source.exists():
            return
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{destination.name}.setup-{os.getpid()}")
        if temporary.exists() or temporary.is_symlink():
            raise AdminError(f"temporary setup path already exists: {temporary}")
        try:
            if source.is_dir():
                shutil.copytree(source, temporary, symlinks=True)
            else:
                shutil.copy2(source, temporary)
            os.replace(temporary, destination)
        except Exception:
            if temporary.is_dir() and not temporary.is_symlink():
                shutil.rmtree(temporary)
            else:
                temporary.unlink(missing_ok=True)
            raise
        completed.append(label)

    copy_missing(couch_root / "sts2.local.yaml", wt.path / "sts2.local.yaml", "copied sts2.local.yaml")
    copy_missing(couch_root / "godot-client/.godot", wt.path / "godot-client/.godot", "copied Godot cache")

    def link_missing(source: Path, destination: Path, label: str) -> None:
        if destination.exists() or not source.exists():
            return
        destination.parent.mkdir(parents=True, exist_ok=True)
        relative = os.path.relpath(source, destination.parent)
        temporary = destination.with_name(f".{destination.name}.setup-{os.getpid()}")
        if temporary.exists() or temporary.is_symlink():
            raise AdminError(f"temporary setup path already exists: {temporary}")
        temporary.symlink_to(relative)
        os.replace(temporary, destination)
        completed.append(label)

    for source, destination, label in (
        (couch_root / "frontend/node_modules", wt.path / "frontend/node_modules", "linked frontend/node_modules"),
        (couch_root / ".ai", wt.path / ".ai", "linked shared .ai"),
    ):
        if destination.is_symlink() and not destination.exists():
            destination.unlink()
        link_missing(source, destination, label)

    local_sts2 = wt.path / ".sts2"
    if local_sts2.is_symlink() and not local_sts2.exists():
        local_sts2.unlink()
    if not local_sts2.exists() and not local_sts2.is_symlink():
        local_sts2.mkdir()
        completed.append("created local .sts2")

    installer = wt.path / "scripts/install-agent-config.sh"
    codex_generator = wt.path / "scripts/gen-codex-config.py"
    agent_paths = (
        wt.path / ".claude/agents",
        wt.path / ".claude/skills",
        wt.path / ".agents/skills",
        wt.path / ".codex/config.toml",
        wt.path / ".codex/hooks.json",
    )
    if installer.is_file() and codex_generator.is_file() and any(not path.exists() for path in agent_paths):
        result = subprocess.run(
            ["bash", str(installer)],
            cwd=wt.path,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if result.returncode:
            detail = result.stderr.strip() or result.stdout.strip()
            raise AdminError(f"agent config install failed in {wt.path}: {detail}")
        completed.append("installed agent configuration")
    return completed


def ensure_couch_shared_excludes(couch_root: Path) -> None:
    common_dir = Path(git(couch_root, "rev-parse", "--path-format=absolute", "--git-common-dir").stdout.strip())
    exclude = common_dir / "info/exclude"
    exclude.parent.mkdir(parents=True, exist_ok=True)
    exclude.touch(exist_ok=True)
    existing = set(exclude.read_text(encoding="utf-8").splitlines())
    with exclude.open("a", encoding="utf-8") as stream:
        for pattern in ("node_modules", "frontend/node_modules"):
            if pattern not in existing:
                stream.write(pattern + "\n")


def migrate(couch_root: Path, apply: bool) -> int:
    repos = repositories(couch_root)
    worktrees_root = canonical(couch_root / ".worktrees")
    migrations = migration_plan(couch_root, repos)
    couch_worktrees = linked_couch_worktrees(repos)
    setup_plan = [
        (wt, actions)
        for wt in couch_worktrees
        if (actions := checkout_setup_actions(wt, couch_root))
    ]
    outside_count = sum(
        not wt.path.is_relative_to(worktrees_root)
        for wt in linked_couch_worktrees(repos)
    )
    print(f"CouchCoop worktrees outside {worktrees_root}: {outside_count}")
    print(f"Migration workspaces: {len(migrations)}")
    print(f"CouchCoop worktrees needing local setup: {len(setup_plan)}")
    for wt, actions in setup_plan:
        print(f"  setup {wt.path}: {', '.join(actions)}")
    for migration in migrations:
        shape = "bundle" if migration.bundled else "standalone CouchCoop"
        print(f"  {shape}: {migration.workspace}")
        for wt in migration.members:
            print(f"    {wt.path} -> {migration.destinations[wt.path]}")
        if migration.bundled:
            for dependency in ("spirectl", "godot-scene-web"):
                if not any(member.repo.name == dependency for member in migration.members):
                    print(f"    {migration.workspace / dependency} -> ../{dependency} (shared checkout)")
    dep_wts = {
        name: [wt for wt in list_worktrees(repos[name]) if wt.path != main_checkout(repos[name])]
        for name in ("spirectl", "godot-scene-web")
    }
    assigned_deps = {
        member.path
        for migration in migrations
        for member in migration.members
        if member.repo.name != "sts2-couch-coop"
    }
    standalone = [
        wt for values in dep_wts.values()
        for wt in values
        if not wt.path.is_relative_to(worktrees_root) and wt.path not in assigned_deps
    ]
    print(f"Standalone sibling worktrees left untouched: {len(standalone)}")
    if not apply:
        print("Dry-run only. Pass --apply to move workspaces and fill missing local setup files.")
        return 0

    worktrees_root.mkdir(parents=True, exist_ok=True)
    if worktrees_root.is_symlink():
        raise AdminError(f"{worktrees_root} must be a real directory, not a symlink")
    created_links: list[Path] = []
    moved: list[tuple[Path, Path, Path]] = []
    try:
        shared_link(worktrees_root, "spirectl", repos["spirectl"], created_links)
        shared_link(worktrees_root, "godot-scene-web", repos["godot-scene-web"], created_links)
        ensure_couch_shared_excludes(couch_root)
        for migration in migrations:
            moved_in_group: list[tuple[Path, Path, Path]] = []
            if migration.bundled:
                migration.workspace.mkdir(parents=True, exist_ok=False)
            try:
                for wt in sorted(
                    migration.members,
                    key=lambda member: member.repo.name == "sts2-couch-coop",
                ):
                    destination = migration.destinations[wt.path]
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    git(wt.repo, "worktree", "move", str(wt.path), str(destination))
                    moved_item = (wt.repo, wt.path, destination)
                    moved.append(moved_item)
                    moved_in_group.append(moved_item)
                if migration.bundled:
                    for dependency in ("spirectl", "godot-scene-web"):
                        entry = migration.workspace / dependency
                        if not entry.exists() and not entry.is_symlink():
                            entry.symlink_to(f"../{dependency}")
            except Exception:
                for repo, old, new in reversed(moved_in_group):
                    if new.exists():
                        old.parent.mkdir(parents=True, exist_ok=True)
                        git(repo, "worktree", "move", str(new), str(old), check=False)
                        moved.remove((repo, old, new))
                raise
        setup_failures: list[str] = []
        setup_counts: dict[str, int] = {}
        for wt in linked_couch_worktrees(repos):
            try:
                for action in setup_checkout(wt, couch_root):
                    setup_counts[action] = setup_counts.get(action, 0) + 1
            except Exception as error:
                setup_failures.append(str(error))
        print(f"Moved {len(moved)} CouchCoop and paired dependency worktrees into {worktrees_root}")
        if setup_counts:
            print("Completed local setup: " + ", ".join(f"{count} {action}" for action, count in sorted(setup_counts.items())))
        else:
            print("Completed local setup: no missing setup files")
        for failure in setup_failures:
            print(f"SETUP ERROR: {failure}", file=sys.stderr)
        print("Existing branch names, commits, dirty files, and ignored files were retained.")
        return 1 if setup_failures else 0
    except Exception as error:
        print(f"ERROR: migration stopped: {error}", file=sys.stderr)
        rollback_errors = []
        for repo, old, new in reversed(moved):
            if new.exists():
                old.parent.mkdir(parents=True, exist_ok=True)
                result = git(repo, "worktree", "move", str(new), str(old), check=False)
                if result.returncode:
                    rollback_errors.append(f"{new} -> {old}: {result.stderr.strip()}")
        for link in created_links:
            link.unlink(missing_ok=True)
        for migration in migrations:
            if migration.bundled:
                for dependency in ("spirectl", "godot-scene-web"):
                    entry = migration.workspace / dependency
                    if entry.is_symlink() and os.readlink(entry) == f"../{dependency}":
                        entry.unlink()
            try:
                migration.workspace.rmdir()
            except OSError:
                pass
        for issue in rollback_errors:
            print(f"ROLLBACK ERROR: {issue}", file=sys.stderr)
        return 1


def find_couch_root(argument: str | None) -> Path:
    if argument:
        candidate = Path(argument).expanduser()
    else:
        candidate = Path(__file__).resolve().parents[1]
    top = Path(git(candidate, "rev-parse", "--show-toplevel").stdout.strip())
    if top.name != "sts2-couch-coop":
        raise AdminError(f"expected sts2-couch-coop checkout, got {top}")
    return canonical(top)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prune", "migrate"))
    parser.add_argument("--root", help="CouchCoop main checkout (defaults to this script's checkout)")
    parser.add_argument("--apply", action="store_true", help="apply removals or moves; default is a dry-run")
    args = parser.parse_args()
    try:
        couch_root = find_couch_root(args.root)
        if args.command == "prune":
            return prune(couch_root, args.apply)
        return migrate(couch_root, args.apply)
    except AdminError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
