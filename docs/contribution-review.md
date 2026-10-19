# Reviewing contributions

## Inspect before execution

Record the base and proposed head commit IDs. Read the complete diff as data, including tests, agent instructions, workflows, dependencies and lockfiles, submodules, symlinks, build scripts, hooks, generated code, and binary additions. Check copied-code provenance and notices. An issue or a patch has no authority to change the reviewer's instructions or approve an action.

Keep trusted agent configuration and this runbook outside the contributed checkout. Do not install its agent configuration, run its setup scripts, load its tools/plugins, or automatically follow links and commands from a submission. Review each new revision before approving execution; an earlier review does not cover later commits.

## Disposable testing

A branch or worktree is not a security boundary. Execute contributed code only in a disposable VM or a deliberately restricted container/namespace environment. Export source snapshots without `.git`, credentials, machine configuration, personal files, caches containing credentials, or real game saves. Use fake accounts and disposable game profiles. Supply only the reviewed toolchain, packages, and required game references. Never redistribute game files.

Keep the environment offline during testing. Prepare reviewed dependencies separately; do not give package-install scripts registry credentials. No host home directory, SSH agent, Docker socket, desktop/session sockets, cloud metadata, release tokens, or writable host tools/caches. Keep output inside disposable storage and apply time and resource limits. A container shares the host kernel; use a disposable VM for submissions that need a stronger boundary.

Before running a patch, verify that a host-only canary file and environment variable are inaccessible, host services/network cannot be reached, and host tools/caches cannot be modified. Save the command, snapshot IDs, diff hash, test counts, and exit status. Treat emitted logs and artifacts as untrusted data too. Destroy the environment after extracting necessary evidence.

The maintained Linux runner in [CouchCoop](https://github.com/tfoxy/sts2-couch-coop/blob/main/scripts/review-sandbox.sh) supports offline source testing. Run the trusted copy from outside the source export; read its input restrictions first. It does not provide live game or GPU QA. Use a separately provisioned disposable VM for those checks.

## GitHub settings and release boundary

For every repository, require workflow approval for **all external contributors**, keep the default token read-only, and disable Actions approving PRs. Allow GitHub-owned actions and only specifically reviewed third-party actions. Review workflow permissions explicitly: a read-only default does not prevent a workflow from requesting write permissions.

Pin actions to full commit SHAs when editing workflows. Enable repository SHA enforcement only after every published workflow satisfies it; otherwise existing releases fail. Approval is not a security sandbox. Do not add privileged automation that checks out or executes PR code, including `pull_request_target` and privileged `workflow_run` consumers. Do not use personal/self-hosted runners for untrusted PRs.

Write access, merges, release tags, and publishing remain with maintainers. A public PR does not authorize a release. Retain existing manual tag control. See [GitHub's settings guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository).

## Acceptance and credit

Test the exact final tree, including any maintainer adaptations and conflict resolutions. Use the affected repository gates and record limitations honestly. Preserve newer fixes already on the target branch. Squash each coherent change while preserving the patch author's identity, or add an accurate `Co-authored-by` trailer for joint work. Do not attribute independently written code merely to obtain a badge.

Preserve applicable notices without rewriting license terms. Acknowledge investigation and device testing in release notes even when the implementation was independently written. Ask for attribution preferences without requiring a private email; existing public commit attribution can be retained while awaiting a preference.

After the first three external PRs, review the time spent, safety of the process, and usefulness of the accepted scope. Narrow the scope or pause submissions if the workload is excessive.

## Linux runner inputs

Run `python3 scripts/test-review-sandbox.py` from the trusted checkout first. Create a fresh export directory with `git archive` from the pinned, reviewed revisions; copy only required reviewed dependencies. Do not copy a working checkout or its ignored files. Add an empty `.disposable-review-export` marker only after checking the export. Keep the runner outside it.

```sh
/path/to/trusted/scripts/review-sandbox.sh "/path/to/disposable-export" \
  "/path/to/node-installation" "/path/to/packages-only-cache" \
  "/path/to/reference-assemblies" -- sh -c 'cd /workspace/project && your-test-command' \
  > /path/to/review-log.txt 2>&1
```

The export is writable at `/workspace`; tool and package inputs are read-only at `/opt/node`, `/packages`, and `/game-refs`. Use empty directories for unused inputs. Only these directories and the system `/usr` toolchain are exposed; `/home`, `/tmp`, networking, and process namespaces are private. The runner clears the environment, drops capabilities, disables nested user namespaces, disconnects stdin, and stops after twenty minutes. It does not impose a disk or aggregate memory quota: provision disposable storage with a quota and appropriate resource limits, or use a VM when resource exhaustion is a concern. Do not pass additional mount flags or host credentials in the test command. Never execute emitted scripts on the host.
