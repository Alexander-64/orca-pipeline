# Agent Pipeline

[Русский](README.md) · [English](README.en.md) · [简体中文](README.zh-CN.md)

An Orca plugin for agent DAG workflows: a planner produces YAML, Orca executes Run/Task/Dispatch steps, Beads tracks work, and the coordinator can move a confirmed quota-failed step to the next agent with a continuation checkpoint.

Publisher: [Alexander-64 on GitHub](https://github.com/Alexander-64). License: [MIT](LICENSE).

Version **0.1.1** uses manifest v2, `id: "agent-pipeline"` and `license: "MIT"`. The deprecated `publisher` field is removed: Orca derives the owner from GitHub, giving the install key `alexander-64.agent-pipeline`. A local folder without publisher uses `local.agent-pipeline`.

## Install from a tag

Once the 0.1.1 tag is published:

```sh
orca plugin install Alexander-64/orca-pipeline@v0.1.1 --json
```

Requires **Orca 1.4.248+** and its `orca` CLI. Orca pins the tag's exact commit. This executable plugin requires approval: review the access and, if you agree, run the command Orca returns with `--approve <fingerprint>`. A `trusted-worker` is a separate Node process with full user access to files, networking and external programs. Capabilities control Orca API calls; they do not sandbox that process.

Requested capabilities: `agent:read` discovers agents; `workspace:read` lists workspaces; `terminal:send` creates coordinator terminals; `storage:own` persists plans, Runs and the journal; `settings:own` reads plugin settings. One Agent Pipeline panel contains four internal views.

Install/configure `bd` on the coordinator host and initialize Beads in the target repository (`bd init`). Set its command or absolute path in Settings → Plugins → Agent Pipeline → Beads CLI executable; the board reports unavailable bd. Configure external agent CLIs and their accounts in Orca on each execution host. Live quota reading needs `codex app-server`; PR operations need authenticated `gh` on the coordinator host. These CLIs and credentials are not bundled. Node.js 22+ and `npm ci` are development requirements, not tag-install steps.

## Features and UI

- Four views: scenario, execution, metrics and Beads. Templates, YAML and the visual DAG editor share the same draft. The map groups steps into dependency waves and displays agents and gates.
- Select a step to edit fields and dependencies in the inspector, then apply after validation. Add an independent or dependent step, duplicate, or delete a step (except the last); references to deleted steps are removed. Scenario name and objective are editable above the map.
- Map, YAML and side-by-side modes persist across panel openings. Side-by-side uses a responsive grid with separate scroll areas and the inspector below. Invalid YAML keeps the last valid map visible and blocks graph edits until fixed. Validation and execution always use the current YAML draft.
- The Planner card shows objective, agent, running/done/failed state, Run ID and errors; the result summary shows name, objective, step and wave counts. The last plan is restored when reopening the panel; an already applied result does not overwrite later manual edits.
- Planner, step and review agent selectors discover Orca agents. Custom IDs remain available; fallback checkboxes preserve selection order.
- Durable mutation journal with request IDs, request-show and replay avoids duplicate launches after an unknown response. Evidence gates support an independent reviewer and bounded repair/re-review cycles.
- Handoff 2.0 and attempt artifacts include redaction, size limits and safe filenames. Global, provider and host concurrency limits, role policies and quota-aware routing control scheduling.
- Native approval gates, pause/resume/cancel/retry and manual agent replacement; agent metrics and Run timelines; optional post-DAG PR workflow with CI wait and merge only after approval and unchanged-head verification.

## Requirements and development setup

Use Orca **1.4.248+**, its CLI on PATH, and Node.js **22+** for development and tests. Configure the required agent CLIs and accounts in Orca. Install/configure `bd` on the coordinator host. Set its command or absolute path in Settings → Plugins → Agent Pipeline → Beads CLI executable. To use the development dependency, point that setting at the absolute `node_modules/.bin/bd` path. PR operations additionally require authenticated `gh` on the coordinator host.

From a clean checkout:

```sh
npm ci
orca plugin types . --json
npm run typecheck
npm test
npm run check
npm run validate
```

`npm ci` installs the locked development dependencies. `plugin types` generates the ignored `.orca/types` required by tsconfig. `typecheck` checks TypeScript; `test` runs Orca plugin tests; `test:release` separately runs the Node packaging tests; `check` renders the panel and its UI scenarios; `validate` checks the source manifest. Tests/check run trusted local code. For interactive development:

```sh
orca plugin dev watch . --check --shot .orca/shots --json
```

Orca may request approval for trusted-worker execution. YAML is vendored in `vendor/yaml` with its upstream license: Orca loads relative imports without a bundler, so node_modules is not shipped.

## YAML example

```yaml
name: add-export
objective: Add export and verify it with tests
steps:
  - id: implement
    title: Implementation
    spec: Implement the change in the current workspace
    agent: codex
    fallback: [claude, kimi]
    placement:
      host: local
      worktree: current
    acceptance:
      - npm test
  - id: review
    title: Independent review
    needs: [implement]
    spec: Review the diff and rerun the tests
    agent: claude
    placement:
      host: local
      worktree: current
    acceptance:
      - npm test
```

Adapt agent IDs and acceptance commands to the target repository. Dependencies control execution order; independent steps may run concurrently within capacity limits. For an evidence gate, configure a distinct `reviewAgent` on the implementation step; a plain follow-up step is not itself that gate.

## Remote execution, failover and Beads

For a remote step, `placement.host` is a saved Orca environment name. Remote `worktree: current` is forbidden: use an exact workspace selector or `new-top-level`/`new-child` with `placement.repo`. Remote preflight uses allowlists and read-only command policies. An unavailable remote host does not silently move execution locally.

Fallback follows the configured agent order and eligible capacity/policy choices. A confirmed quota failure can produce a continuation checkpoint for the next attempt; silence or an ambiguous launch result is not proof of worker exit. The durable journal allows checking/replaying the original request. Beads supports search, filters, claim/close/reopen, epics and status synchronization; an unavailable `bd` is surfaced in the board.

## Current limitations

Orca confirms completion via Task/worker_done; the assigned worker executes acceptance commands. Use `reviewAgent` for independent verification. Live quota snapshots currently use Codex app-server; other providers use the normal fallback chain. Switching accounts within one provider is unsupported: worker-start has no per-launch account option, and account selection would change the global profile.

PR tests do not create or merge real PRs. Planner and pipeline create separate coordinator terminals in the selected workspace. The plugin runs as a trusted worker and invokes `orca`/`bd` via `execFile` without a shell. Local checks do not prove credentials, remote connectivity or a real publishing/merge workflow.

## Release build and validation

After the clean-checkout checks above:

```sh
npm run build:release -- --out .release-smoke
orca plugin validate .release-smoke --json
```

This validates the actual release directory without installing or publishing it. `npm run build:release` replaces the default `dist/agent-pipeline` with a fresh build, removing stale and dev-only files. It stages in a sibling temporary directory and restores the previous build if replacement fails. `--out <path>` selects another location, relative to the project root if not absolute; it must be new, since only the standard `dist/agent-pipeline` may be replaced. While that directory serves a live installation or active Run, use a fresh `--out` instead.

The dependency-free Node builder executes no shell commands. It copies an explicit production module inventory, manifest, all three READMEs, root LICENSE when present, and `vendor/yaml` including its license. It verifies relative imports and entry points and rejects symlinks, binary content and recognizable credential patterns. Tests, fixtures, UI check scenarios, package manager files, node_modules, `.orca`, `.agent-pipeline`, logs, source maps and other development artifacts are excluded. Add new production modules explicitly to `scripts/build-release.mjs`. Review contents manually for secrets before publishing; pattern scanning cannot guarantee their absence. `npm run test:release` checks the inventory, byte-for-byte source equality and overwrite/symlink protection.

## GitHub and Orca Community publication

The official Community route is a **public GitHub repository** with a **manifest v2 `orca-plugin.json` at its root**. Omit `publisher`: with `engines.orca >=1.4.248`, Orca derives the owner from the GitHub repository. A root **LICENSE** is required; this project uses MIT and retains the separate upstream YAML license. Publish **no binaries, archives or symlinks**. Orca loads TS/TSX sources directly.

The confirmed repository is `https://github.com/Alexander-64/orca-pipeline`. Review the files and diff, and run all checks above. Keep the manifest at the repository root, not only under dist. Align manifest/package versions, add the **`orca-plugin` topic**, then create and push the **`v0.1.1` tag** matching this version. Check indexing at `https://orca.dev/plugins/alexander-64/orca-pipeline`. **No PR to `stablyai/orca-plugins` is required for Community.** Local validation does not imply Community indexing has completed.

Once published, users can run `orca plugin install Alexander-64/orca-pipeline@v0.1.1 --json`. Executable plugins require user approval of the access listed by Orca. `private: true` in package.json prevents accidental npm publication and does not prevent GitHub/Community distribution. These instructions do not create a repository, commit, push, tag or publish anything.

References: [Orca authoring guide](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-authoring.md), [manifest](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-manifest.md), [listing](https://orca.dev/plugins/add) and [catalog policy](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-listing-policy.md).
