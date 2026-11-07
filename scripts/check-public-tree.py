#!/usr/bin/env python3
"""Check that a tree is fit to publish: markdown allowlist, path denylist, personal-data scan.

    check-public-tree.py                                   check the index (git ls-files)
    check-public-tree.py --rev <commit>                    check that commit's tree
    check-public-tree.py --push <local> <remote> [<name>]  pre-push: ancestry, tree, pushed commits

Rules live in scripts/public-tree.conf (format documented at its top). When the repo root holds
private/public-tree-private.conf (the gitignored private companion), its rules are added; those
can hold literal personal data, so a violation of one is reported by file:line and rule number,
never by its pattern. Matched text is never printed for any text rule, public or private: the
output of this script ends up in CI logs.

--push runs three checks for one ref being pushed:
  1. no `old-root` commit (a root of the history before a rewrite) is an ancestor of <local>;
  2. the tree of <local> passes the same checks as --rev;
  3. no commit in the pushed range adds or modifies a `deny` path, so a file added and deleted
     again inside the range is still caught. The range is <remote>..<local>, or
     `<local> --not --remotes=<name>` when <remote> is all zeros (a new branch) or unknown here.
An all-zero <local> is a deletion and passes.

Exit status: 0 clean, 1 violation, 2 usage or configuration error. Python 3 stdlib only.
Self-test: scripts/test-check-public-tree.sh
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from dataclasses import dataclass

CONF = "scripts/public-tree.conf"
PRIVATE_CONF = "private/public-tree-private.conf"
SELF = "scripts/check-public-tree.py"
# The script and its public conf necessarily spell out the patterns they deny.
TEXT_EXEMPT = (SELF, CONF)
KINDS = ("allow-md", "deny", "deny-text", "allow-text", "old-root")
SHA_RE = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")


class UsageError(Exception):
    pass


@dataclass
class Rule:
    kind: str
    value: str
    source: str  # file the rule came from
    line: int
    index: int  # 1-based position among the rules of its kind
    private: bool
    regex: re.Pattern | None = None

    def label(self) -> str:
        """How a violation names this rule. Private rules never show their value."""
        if self.private:
            return f"private {self.kind} rule #{self.index} ({self.source}:{self.line})"
        return f"{self.kind} `{self.value}`"


# ---------------------------------------------------------------------------------------------
# git
# ---------------------------------------------------------------------------------------------


def git(*args: str, check: bool = True, text: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run(
        ["git", "-c", "core.quotePath=false", *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=text,
        encoding="utf-8" if text else None,
        errors="replace" if text else None,
    )
    if check and proc.returncode != 0:
        err = proc.stderr if text else proc.stderr.decode("utf-8", "replace")
        raise UsageError(f"git {' '.join(args)} failed: {err.strip()}")
    return proc


def is_zero(sha: str) -> bool:
    return bool(sha) and set(sha) == {"0"}


def commit_exists(sha: str) -> bool:
    return git("cat-file", "-e", f"{sha}^{{commit}}", check=False).returncode == 0


# ---------------------------------------------------------------------------------------------
# globs
# ---------------------------------------------------------------------------------------------


def _segment(seg: str) -> str:
    out, i = [], 0
    while i < len(seg):
        c = seg[i]
        if c == "*":
            out.append("[^/]*")
        elif c == "?":
            out.append("[^/]")
        elif c == "[":
            j = seg.find("]", i + 2)
            if j == -1:
                out.append(re.escape(c))
            else:
                body = seg[i + 1 : j]
                if body.startswith("!"):
                    body = "^" + body[1:]
                out.append("[" + body.replace("\\", "\\\\") + "]")
                i = j
        else:
            out.append(re.escape(c))
        i += 1
    return "".join(out)


def glob_to_regex(glob: str) -> re.Pattern:
    """`*` and `?` stay inside one path segment, `**` as a whole segment spans any number of
    them (zero included), `[...]` is a character class. Anchored at the repo root."""
    parts = glob.strip("/").split("/")
    out = []
    for i, part in enumerate(parts):
        last = i == len(parts) - 1
        if part == "**":
            out.append(".*" if last else "(?:[^/]+/)*")
        else:
            out.append(_segment(part) + ("" if last else "/"))
    return re.compile("^" + "".join(out) + "$")


# ---------------------------------------------------------------------------------------------
# configuration
# ---------------------------------------------------------------------------------------------


def parse_conf(text: str, source: str, private: bool, rules: dict[str, list[Rule]]) -> None:
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        kind, _, value = line.partition(" ")
        value = value.strip()
        if kind not in KINDS or not value:
            raise UsageError(f"{source}:{n}: expected `<{'|'.join(KINDS)}> <value>`")
        rule = Rule(kind, value, source, n, len(rules[kind]) + 1, private)
        if kind in ("allow-md", "deny"):
            rule.regex = glob_to_regex(value)
        elif kind == "deny-text":
            try:
                rule.regex = re.compile(value)
            except re.error as exc:
                raise UsageError(f"{source}:{n}: bad regex ({exc})") from None
        elif kind == "old-root" and not SHA_RE.match(value):
            raise UsageError(f"{source}:{n}: old-root wants a full lowercase commit sha")
        rules[kind].append(rule)


def load_rules(root: str, rev: str | None) -> dict[str, list[Rule]]:
    """The public conf from the tree under check when it has one (so a branch that adds an
    allowed doc carries its own allowlist entry), else from the working tree."""
    rules: dict[str, list[Rule]] = {k: [] for k in KINDS}
    try:
        with open(os.path.join(root, CONF), encoding="utf-8") as fh:
            worktree_text: str | None = fh.read()
    except FileNotFoundError:
        worktree_text = None
    text = None
    if rev is not None:
        proc = git("show", f"{rev}:{CONF}", check=False)
        if proc.returncode == 0:
            text = proc.stdout
    if text is None:
        text = worktree_text
    if text is None:
        raise UsageError(f"{CONF} not found")
    parse_conf(text, CONF, False, rules)
    if worktree_text is not None and text is not worktree_text:
        # Ancestry is judged by this checkout's list too: an old branch's own conf may predate
        # the rewrite that its history is refused for.
        extra: dict[str, list[Rule]] = {k: [] for k in KINDS}
        parse_conf(worktree_text, CONF, False, extra)
        have = {r.value for r in rules["old-root"]}
        for r in extra["old-root"]:
            if r.value not in have:
                r.index = len(rules["old-root"]) + 1
                rules["old-root"].append(r)
    private_path = os.path.join(root, PRIVATE_CONF)
    if os.path.isfile(private_path):
        with open(private_path, encoding="utf-8") as fh:
            parse_conf(fh.read(), PRIVATE_CONF, True, rules)
    return rules


# ---------------------------------------------------------------------------------------------
# checks
# ---------------------------------------------------------------------------------------------


def deny_hits(paths: list[str], rules: list[Rule]) -> dict[str, Rule]:
    """path -> first deny rule that matches it or one of its parent directories."""
    if not rules:
        return {}
    candidates: set[str] = set()
    for p in paths:
        parts = p.split("/")
        candidates.update("/".join(parts[:i]) for i in range(1, len(parts) + 1))
    denied: dict[str, Rule] = {}
    for cand in sorted(candidates):
        for rule in rules:
            if rule.regex.match(cand):
                denied[cand] = rule
                break
    out: dict[str, Rule] = {}
    for p in paths:
        parts = p.split("/")
        for i in range(1, len(parts) + 1):
            hit = denied.get("/".join(parts[:i]))
            if hit:
                out[p] = hit
                break
    return out


def is_markdown(path: str) -> bool:
    return path.lower().endswith((".md", ".mdx"))


def grep_hits(rev: str | None, rules: dict[str, list[Rule]]) -> list[tuple[str, int, Rule]]:
    denies = rules["deny-text"]
    if not denies:
        return []
    allows = [r.value for r in rules["allow-text"]]
    where = [rev] if rev is not None else ["--cached"]
    spec = ["--", ".", *[f":(exclude,top){p}" for p in TEXT_EXEMPT]]
    pats: list[str] = []
    for r in denies:
        pats += ["-e", r.value]
    # PCRE is close to Python's dialect; a git built without it falls back to ERE. Every hit is
    # re-checked with Python's re, so the prefilter only has to be a superset.
    proc = None
    for mode in ("-P", "-E"):
        proc = git("grep", "-nIz", mode, *pats, *where, *spec, check=False)
        if proc.returncode in (0, 1):
            break
    if proc.returncode not in (0, 1):
        raise UsageError(f"git grep failed: {proc.stderr.strip()}")
    prefix = f"{rev}:" if rev is not None else ""
    hits: list[tuple[str, int, Rule]] = []
    for row in proc.stdout.split("\n"):
        if not row:
            continue
        fields = row.split("\0", 2)
        if len(fields) != 3:
            continue
        path, lineno, content = fields
        if prefix and path.startswith(prefix):
            path = path[len(prefix) :]
        spans = []
        for lit in allows:
            start = content.find(lit)
            while start != -1:
                spans.append((start, start + len(lit)))
                start = content.find(lit, start + 1)
        for rule in denies:
            if any(
                not any(a <= m.start() and m.end() <= b for a, b in spans)
                for m in rule.regex.finditer(content)
            ):
                hits.append((path, int(lineno), rule))
    return hits


def check_tree(rev: str | None, rules: dict[str, list[Rule]], what: str) -> list[str]:
    if rev is None:
        listing = git("ls-files", "-z").stdout
    else:
        listing = git("ls-tree", "-r", "-z", "--name-only", "--full-tree", rev).stdout
    paths = sorted(p for p in listing.split("\0") if p)
    problems: list[str] = []

    denied = deny_hits(paths, rules["deny"])
    for path in paths:
        if path in denied:
            problems.append(f"[deny] {path}: matches {denied[path].label()}")
        elif is_markdown(path) and not any(r.regex.match(path) for r in rules["allow-md"]):
            problems.append(
                f"[allow-md] {path}: markdown file is not on the allowlist ({CONF}: allow-md)"
            )
    for path, lineno, rule in grep_hits(rev, rules):
        problems.append(f"[deny-text] {path}:{lineno}: matches {rule.label()}")

    print(f"check-public-tree: {what} ({len(paths)} files)")
    return problems


def check_push(local: str, remote: str, name: str | None, rules: dict[str, list[Rule]]) -> list[str]:
    problems: list[str] = []
    for rule in rules["old-root"]:
        rc = git("merge-base", "--is-ancestor", rule.value, local, check=False).returncode
        if rc == 0:
            root = rule.label() if rule.private else f"old root {rule.value[:12]}"
            problems.append(
                f"[old-root] {local[:12]} descends from {root}: this branch still carries "
                "pre-rewrite history; port it with private/rewrite/port-branch.sh"
            )
    if problems:
        # The history itself is the problem; a tree and range scan of it would only add noise.
        return problems

    problems += check_tree(local, rules, f"push {local[:12]}")

    if not is_zero(remote) and commit_exists(remote):
        rng = [local, f"^{remote}"]
        desc = f"{remote[:12]}..{local[:12]}"
    else:
        # A URL instead of a remote name matches no remote-tracking ref: exclude every remote.
        if name and re.match(r"^[A-Za-z0-9._-]+$", name):
            rng = [local, "--not", f"--remotes={name}"]
        else:
            rng = [local, "--not", "--remotes"]
        desc = f"{local[:12]} not on {name or 'any remote'}"
    log = git(
        "log", "--no-renames", "--diff-filter=ACMRT", "--name-only", "--format=@@%H", *rng
    ).stdout
    commits = 0
    commit = ""
    changed: dict[str, list[str]] = {}
    for row in log.splitlines():
        if row.startswith("@@"):
            commit = row[2:]
            commits += 1
        elif row:
            changed.setdefault(row, []).append(commit)
    for path, rule in sorted(deny_hits(list(changed), rules["deny"]).items()):
        shas = ", ".join(c[:12] for c in changed[path][:3])
        more = f" (+{len(changed[path]) - 3} more)" if len(changed[path]) > 3 else ""
        problems.append(f"[deny] {path}: added or changed by {shas}{more}; matches {rule.label()}")
    print(f"check-public-tree: pushed range {desc} ({commits} commits)")
    return problems


def main(argv: list[str]) -> int:
    args = argv[1:]
    mode = "index"
    if args[:1] in (["-h"], ["--help"]):
        print(__doc__.strip())
        return 0
    if args and args[0] == "--rev" and len(args) == 2:
        mode = "rev"
    elif args and args[0] == "--push" and len(args) in (3, 4):
        mode = "push"
    elif args:
        print(__doc__.strip().split("\n\n")[1], file=sys.stderr)
        return 2

    try:
        root = git("rev-parse", "--show-toplevel").stdout.strip()
        os.chdir(root)
        if mode == "index":
            rules = load_rules(root, None)
            problems = check_tree(None, rules, "index")
        elif mode == "rev":
            rev = git("rev-parse", "--verify", f"{args[1]}^{{commit}}").stdout.strip()
            rules = load_rules(root, rev)
            problems = check_tree(rev, rules, f"commit {rev[:12]}")
        else:
            local, remote = args[1], args[2]
            name = args[3] if len(args) == 4 else None
            if is_zero(local):
                print("check-public-tree: ref deletion, nothing to check")
                return 0
            local = git("rev-parse", "--verify", f"{local}^{{commit}}").stdout.strip()
            rules = load_rules(root, local)
            problems = check_push(local, remote, name, rules)
    except UsageError as exc:
        print(f"check-public-tree: error: {exc}", file=sys.stderr)
        return 2

    for p in problems:
        print(f"  {p}")
    if problems:
        print(
            f"check-public-tree: {len(problems)} violation(s). Public material needs an allow-md "
            f"entry in {CONF}; internal material belongs in the private companion (private/).",
        )
        return 1
    print("check-public-tree: clean")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
