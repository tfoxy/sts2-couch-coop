#!/usr/bin/env python3
"""Fixture checks for CouchCoop and Spirectl worktree creation, pruning, and migration."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))
import worktree_admin  # noqa: E402


def run(args: list[str], *, cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(args, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and result.returncode:
        raise AssertionError(f"command failed ({result.returncode}): {args}\n{result.stdout}{result.stderr}")
    return result


def git(repo: Path, *args: str, check: bool = True) -> str:
    return run(["git", "-C", str(repo), *args], check=check).stdout.strip()


def init_repo(path: Path, *, files: dict[str, str] | None = None) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    run(["git", "init", "--initial-branch=main", str(path)])
    git(path, "config", "user.name", "Fixture")
    git(path, "config", "user.email", "fixture@example.invalid")
    (path / ".gitignore").write_text(
        ".worktrees\nnode_modules\nfrontend/node_modules\n.godot\n"
        "godot-client/.godot\n.ai\n.agents\n.claude\n.codex\n.sts2\n"
        "sts2.local.yaml\ntarget\n.vscode\npresentation/web/node_modules\nignored.fixture\n.fixture-installed\n",
        encoding="utf-8",
    )
    (path / "tracked.txt").write_text("base\n", encoding="utf-8")
    for relative, content in (files or {}).items():
        target = path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    git(path, "add", "-A")
    git(path, "commit", "-m", "fixture base")
    return path


def add_worktree(repo: Path, path: Path, branch: str | None = None, commit: str = "main") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if branch:
        git(repo, "worktree", "add", "-b", branch, str(path), commit)
    else:
        git(repo, "worktree", "add", "--detach", str(path), commit)
    return path


def commit_change(worktree: Path, content: str) -> str:
    (worktree / "tracked.txt").write_text(content, encoding="utf-8")
    git(worktree, "add", "tracked.txt")
    git(worktree, "commit", "-m", "fixture change")
    return git(worktree, "rev-parse", "HEAD")


def make_repos(base: Path, *, couch_files: dict[str, str] | None = None) -> dict[str, Path]:
    return {
        "sts2-couch-coop": init_repo(base / "sts2-couch-coop", files=couch_files),
        "spirectl": init_repo(base / "spirectl"),
        "godot-scene-web": init_repo(base / "godot-scene-web"),
    }


def test_prune_fixtures(base: Path) -> None:
    repos = make_repos(base)
    couch = repos["sts2-couch-coop"]
    root = base / "checkouts"

    clean = add_worktree(couch, root / "clean", "worktree/clean")
    (clean / "ignored.fixture").write_text("remove only on apply\n", encoding="utf-8")

    dirty = add_worktree(couch, root / "dirty", "worktree/dirty")
    (dirty / "tracked.txt").write_text("dirty\n", encoding="utf-8")
    (dirty / "untracked.fixture").write_text("keep\n", encoding="utf-8")

    unmerged = add_worktree(couch, root / "unmerged", "worktree/unmerged")
    unmerged_commit = commit_change(unmerged, "unmerged\n")

    detached_clean = add_worktree(couch, root / "detached-clean")
    detached_unmerged = add_worktree(couch, root / "detached-unmerged", commit=unmerged_commit)

    paired_parent = root / "paired"
    bundled_couch = add_worktree(couch, paired_parent / "sts2-couch-coop", "worktree/bundle-couch")
    spirectl = repos["spirectl"]
    bundled_spirectl = add_worktree(spirectl, paired_parent / "spirectl", "worktree/bundle-spirectl")
    commit_change(bundled_spirectl, "dependency unmerged\n")
    bundled_gsw = add_worktree(repos["godot-scene-web"], paired_parent / "godot-scene-web", "worktree/bundle-gsw")

    dry = run([sys.executable, str(SCRIPT_DIR / "worktree_admin.py"), "prune", "--root", str(couch)])
    assert "CouchCoop linked worktrees: 6" in dry.stdout, dry.stdout
    assert "detached" in dry.stdout and "clean+unmerged" in dry.stdout, dry.stdout
    assert "Eligible workspaces: 2 / 6" in dry.stdout, dry.stdout
    assert clean.exists() and detached_clean.exists() and bundled_couch.exists() and bundled_spirectl.exists()

    applied = run([sys.executable, str(SCRIPT_DIR / "worktree_admin.py"), "prune", "--root", str(couch), "--apply"])
    assert "Apply complete; removal errors: 0" in applied.stdout, applied.stdout
    assert not clean.exists() and not detached_clean.exists()
    assert not (clean / "ignored.fixture").exists()
    assert dirty.exists() and unmerged.exists() and detached_unmerged.exists()
    assert bundled_couch.exists() and bundled_spirectl.exists() and bundled_gsw.exists()
    assert run(["git", "-C", str(couch), "show-ref", "--verify", "--quiet", "refs/heads/worktree/clean"], check=False).returncode != 0
    assert run(["git", "-C", str(spirectl), "show-ref", "--verify", "--quiet", "refs/heads/worktree/bundle-spirectl"], check=False).returncode == 0
    assert git(couch, "rev-parse", "refs/heads/worktree/unmerged") == unmerged_commit


def test_migration_fixtures(base: Path) -> None:
    repos = make_repos(
        base,
        couch_files={
            "scripts/install-agent-config.sh": "#!/usr/bin/env bash\nset -euo pipefail\ntouch .fixture-installed\n",
            "scripts/gen-codex-config.py": "# fixture marker for installer preflight\n",
        },
    )
    couch = repos["sts2-couch-coop"]
    (couch / "sts2.local.yaml").write_text("game:\n  path: fixture\n", encoding="utf-8")
    (couch / "godot-client/.godot/imported").mkdir(parents=True)
    (couch / "godot-client/.godot/imported/cache.fixture").write_text("cache\n", encoding="utf-8")
    (couch / "frontend/node_modules").mkdir(parents=True)
    (couch / "frontend/node_modules/package.fixture").write_text("shared\n", encoding="utf-8")
    (couch / ".ai").mkdir()
    paired_parent = base / "old-round" / "known-pair"
    paired_couch = add_worktree(couch, paired_parent / "sts2-couch-coop", "worktree/migrate-pair")
    paired_spirectl = add_worktree(repos["spirectl"], paired_parent / "spirectl", "worktree/migrate-spirectl")
    (paired_couch / "frontend").mkdir()
    (paired_couch / "frontend/node_modules").symlink_to("../../old-round/node_modules")
    (paired_couch / "tracked.txt").write_text("dirty survives\n", encoding="utf-8")
    (paired_couch / "untracked.fixture").write_text("also survives\n", encoding="utf-8")
    (paired_couch / "ignored.fixture").write_text("ignored survives\n", encoding="utf-8")

    solo = add_worktree(couch, base / "old-round" / "solo-couch", "worktree/migrate-solo")
    flat_cc = add_worktree(couch, base / "cc", "worktree/migrate-flat-cc")
    standalone_spirectl = add_worktree(repos["spirectl"], base / "old-round" / "spirectl-only", "worktree/standalone-spirectl")
    standalone_gsw = add_worktree(repos["godot-scene-web"], base / "old-round" / "gsw-only", "worktree/standalone-gsw")

    worktrees_root = couch / ".worktrees"
    collision = worktree_admin.migration_name(paired_couch, worktrees_root)
    worktrees_root.mkdir()
    collision.mkdir()
    paired_destination = collision.with_name(collision.name + "-2")
    solo_destination = worktree_admin.migration_name(solo, worktrees_root)
    flat_cc_destination = worktree_admin.migration_name(flat_cc, worktrees_root)

    dry = run([sys.executable, str(SCRIPT_DIR / "worktree_admin.py"), "migrate", "--root", str(couch)])
    assert "Migration workspaces: 3" in dry.stdout, dry.stdout
    assert "Standalone sibling worktrees left untouched: 2" in dry.stdout, dry.stdout
    assert paired_couch.exists() and solo.exists() and standalone_spirectl.exists() and standalone_gsw.exists()

    applied = run([sys.executable, str(SCRIPT_DIR / "worktree_admin.py"), "migrate", "--root", str(couch), "--apply"])
    assert "Moved 4 CouchCoop and paired dependency worktrees" in applied.stdout, applied.stdout
    new_couch = paired_destination / "sts2-couch-coop"
    new_spirectl = paired_destination / "spirectl"
    assert new_couch.is_dir() and new_spirectl.is_dir() and solo_destination.is_dir() and flat_cc_destination.is_dir()
    assert not paired_couch.exists() and not paired_spirectl.exists() and not solo.exists() and not flat_cc.exists()
    assert (new_couch / "tracked.txt").read_text(encoding="utf-8") == "dirty survives\n"
    assert (new_couch / "untracked.fixture").read_text(encoding="utf-8") == "also survives\n"
    assert (new_couch / "ignored.fixture").read_text(encoding="utf-8") == "ignored survives\n"
    assert (new_couch / "sts2.local.yaml").read_text(encoding="utf-8") == "game:\n  path: fixture\n"
    assert (new_couch / "godot-client/.godot/imported/cache.fixture").read_text(encoding="utf-8") == "cache\n"
    assert os.readlink(new_couch / "frontend/node_modules") == os.path.relpath(couch / "frontend/node_modules", new_couch / "frontend")
    assert os.readlink(new_couch / ".ai") == os.path.relpath(couch / ".ai", new_couch)
    assert (new_couch / ".sts2").is_dir() and not (new_couch / ".sts2").is_symlink()
    assert (new_couch / ".fixture-installed").exists()
    exclude = Path(git(couch, "rev-parse", "--path-format=absolute", "--git-common-dir")) / "info/exclude"
    assert {"node_modules", "frontend/node_modules"}.issubset(set(exclude.read_text().splitlines()))
    assert git(new_couch, "branch", "--show-current") == "worktree/migrate-pair"
    assert git(new_spirectl, "branch", "--show-current") == "worktree/migrate-spirectl"
    assert os.readlink(paired_destination / "godot-scene-web") == "../godot-scene-web"
    assert (solo_destination / ".fixture-installed").exists()
    assert (worktrees_root / "spirectl").is_symlink()
    assert (worktrees_root / "godot-scene-web").is_symlink()
    assert standalone_spirectl.is_dir() and standalone_gsw.is_dir()
    assert git(repos["spirectl"], "worktree", "list", "--porcelain").find(str(standalone_spirectl)) >= 0
    after = run([sys.executable, str(SCRIPT_DIR / "worktree_admin.py"), "migrate", "--root", str(couch)])
    assert "CouchCoop worktrees outside " + str(worktrees_root) + ": 0" in after.stdout
    assert "Migration workspaces: 0" in after.stdout
    assert "Standalone sibling worktrees left untouched: 2" in after.stdout


def test_couch_creator(base: Path) -> None:
    couch = init_repo(
        base / "sts2-couch-coop",
        files={
            "scripts/create-worktree.sh": (REPO_ROOT / "scripts/create-worktree.sh").read_text(encoding="utf-8"),
            "scripts/install-agent-config.sh": "#!/usr/bin/env bash\nset -euo pipefail\nmkdir -p .codex .claude/agents .claude/skills .agents/memory\ntouch .codex/fixture-installed\n",
        },
    )
    (couch / "sts2.local.yaml").write_text("game:\n  path: fixture\n", encoding="utf-8")
    (couch / "frontend/node_modules").mkdir(parents=True)
    (couch / "frontend/node_modules/package.fixture").write_text("shared\n", encoding="utf-8")
    (couch / "godot-client/.godot/imported").mkdir(parents=True)
    (couch / "godot-client/.godot/imported/cache.fixture").write_text("cache\n", encoding="utf-8")
    (couch / ".ai").mkdir()
    (couch / ".ai/shared.fixture").write_text("shared notes\n", encoding="utf-8")
    deps = {
        "spirectl": init_repo(base / "spirectl"),
        "godot-scene-web": init_repo(base / "godot-scene-web"),
    }

    worktrees_root = couch / ".worktrees"
    worktrees_root.mkdir()
    (worktrees_root / "blocked").mkdir()
    (worktrees_root / "blocked/keep.fixture").write_text("keep\n", encoding="utf-8")
    failed = run(["bash", str(couch / "scripts/create-worktree.sh"), "blocked"], cwd=couch, check=False)
    assert failed.returncode != 0 and (worktrees_root / "blocked/keep.fixture").exists()
    assert not (worktrees_root / "spirectl").exists() and not (worktrees_root / "godot-scene-web").exists()
    assert run(["git", "-C", str(couch), "show-ref", "--verify", "--quiet", "refs/heads/worktree/blocked"], check=False).returncode != 0
    shutil.rmtree(worktrees_root / "blocked")
    clean_status = git(couch, "status", "--porcelain", "--untracked-files=all")
    assert not clean_status, f"fixture main is not clean before creation: {clean_status}"

    run(["bash", str(couch / "scripts/create-worktree.sh"), "flat"], cwd=couch)
    flat = worktrees_root / "flat"
    assert git(flat, "branch", "--show-current") == "worktree/flat"
    assert git(flat, "rev-parse", "HEAD") == git(couch, "rev-parse", "main")
    assert (flat / "sts2.local.yaml").read_text(encoding="utf-8") == "game:\n  path: fixture\n"
    assert (flat / "godot-client/.godot/imported/cache.fixture").read_text(encoding="utf-8") == "cache\n"
    assert os.readlink(flat / "frontend/node_modules") == os.path.relpath(couch / "frontend/node_modules", flat / "frontend")
    assert os.readlink(flat / ".ai") == os.path.relpath(couch / ".ai", flat)
    assert (flat / ".sts2").is_dir() and not (flat / ".sts2").is_symlink()
    assert (flat / ".codex/fixture-installed").exists()
    assert os.readlink(worktrees_root / "spirectl") == os.path.relpath(deps["spirectl"], worktrees_root)
    assert os.readlink(worktrees_root / "godot-scene-web") == os.path.relpath(deps["godot-scene-web"], worktrees_root)
    exclude = Path(git(couch, "rev-parse", "--path-format=absolute", "--git-common-dir")) / "info/exclude"
    assert {"node_modules", "frontend/node_modules"}.issubset(set(exclude.read_text().splitlines()))

    run(["bash", str(couch / "scripts/create-worktree.sh"), "bundle", "--spirectl-ref", "main"], cwd=couch)
    bundle = worktrees_root / "bundle"
    bundled_couch = bundle / "sts2-couch-coop"
    bundled_spirectl = bundle / "spirectl"
    assert git(bundled_couch, "branch", "--show-current") == "worktree/bundle"
    assert git(bundled_spirectl, "branch", "--show-current") == "worktree/bundle"
    assert git(bundled_spirectl, "rev-parse", "HEAD") == git(deps["spirectl"], "rev-parse", "main")
    assert os.readlink(bundle / "godot-scene-web") == "../godot-scene-web"
    assert (bundle / "godot-scene-web").resolve() == deps["godot-scene-web"]
    assert not (bundle / "sts2-couch-coop/.sts2/shared.fixture").exists()


def test_spirectl_creator(base: Path) -> None:
    couch = init_repo(base / "sts2-couch-coop")
    gsw = init_repo(base / "godot-scene-web")
    spirectl = init_repo(
        base / "spirectl",
        files={"scripts/create-worktree.sh": (REPO_ROOT.parent / "spirectl/scripts/create-worktree.sh").read_text(encoding="utf-8")},
    )
    (spirectl / "sts2.local.yaml").write_text("game:\n  path: fixture\ninstances:\n  default: old\n", encoding="utf-8")
    for relative in (".vscode", ".sts2/toolchain", ".sts2/instances", ".agents", ".claude", ".ai", "presentation/web/node_modules"):
        (spirectl / relative).mkdir(parents=True, exist_ok=True)

    created = run(["bash", str(spirectl / "scripts/create-worktree.sh"), "round"], cwd=spirectl)
    assert json.loads(created.stdout)["targetCache"] == "not-copied"
    worktrees_root = couch / ".worktrees"
    dest = worktrees_root / "spirectl-round"
    assert git(dest, "branch", "--show-current") == "worktree/round"
    assert git(dest, "rev-parse", "HEAD") == git(spirectl, "rev-parse", "HEAD")
    config = (dest / "sts2.local.yaml").read_text(encoding="utf-8")
    assert "default: round" in config and "isolatedBuild: true" in config
    assert not (dest / "target").exists()
    assert os.readlink(dest / "presentation/web/node_modules") == os.path.relpath(spirectl / "presentation/web/node_modules", dest / "presentation/web")
    assert os.readlink(worktrees_root / "spirectl") == os.path.relpath(spirectl, worktrees_root)
    assert os.readlink(worktrees_root / "godot-scene-web") == os.path.relpath(gsw, worktrees_root)

    marker = dest / "preserve.fixture"
    marker.write_text("no overwrite\n", encoding="utf-8")
    before = git(dest, "rev-parse", "HEAD")
    failed = run(["bash", str(spirectl / "scripts/create-worktree.sh"), "round"], cwd=spirectl, check=False)
    assert failed.returncode != 0 and marker.read_text(encoding="utf-8") == "no overwrite\n"
    assert git(dest, "rev-parse", "HEAD") == before


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="couch-worktree-fixtures-") as temp:
        base = Path(temp)
        test_prune_fixtures(base / "prune")
        test_migration_fixtures(base / "migration")
        test_couch_creator(base / "couch-creator")
        test_spirectl_creator(base / "spirectl-creator")
    print("worktree tool fixtures passed")


if __name__ == "__main__":
    main()
