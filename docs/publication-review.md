# Publication review · Agent Pipeline 0.2.0

**Status on 18 November 2026.** The table below describes the 0.2.0 review baseline. The fixes, test results and remaining publication steps for 0.2.1 are recorded in the [release verification](release-verification.md).

**Decision: hold the public tag.** The bilingual candidate can be built and rendered from a clean local Git clone. Recovery can still pause another run, and switching projects can show tasks from the wrong project. Resolve these two issues before inviting teams to use concurrent runs.

## Findings in the candidate

| Priority | Evidence and user impact | Release acceptance test |
| --- | --- | --- |
| High · recovery can pause unrelated work | In the `run.repair` handler, a global `recoveryWarning` widens the pause loop to every running coordinator run. The continuation path resumes the selected ID. A second healthy run can remain paused. This finding comes from the worker control flow. | With two active runs and one ambiguous receipt, recover A and verify B’s status, task identity and attempt count before and after. If the receipt cannot be attributed, surface the ambiguity before changing either run. |
| High · stale dashboard after a project switch | `refresh()` assigns every `dashboard.get` reply to the same atom. In an isolated panel test, B was selected, A was reselected, then B answered last. The selector showed A and the Tasks table contained B’s row. A subsequent row action would target the ID carried by that row. | Resolve two project requests in reverse order, including an older failure after a newer success. Assert that the picker, tasks, metrics and errors still describe the last selection. Guard response application by request generation and project. |
| Medium · older terminal history disappears | `TerminalRunBridge.read()` loads and sorts project snapshots, then returns the newest 100. With 101 synthetic local runs, the oldest was absent from discovery while still present in SQLite. The same limited read is used for status lookup. This limit is specific to terminal-owned runs. | Page through 101+ runs and open the first by ID after a restart. Fetch summaries for the picker and the selected record by ID. |
| Medium · artifact writes have unequal privacy and crash behavior | `ArtifactStore.save()` writes an attempt report directly to its destination using process-default permissions. State and checkpoint writers use exclusive temporary files with mode 0600 and rename. A crash can truncate a report; access to a new report depends on the parent directory and umask. | Adopt the private atomic writer for attempt reports. Interrupt a replacement and verify the previous complete file and restrictive permissions on POSIX. |
| Medium · model discovery depends on Orca internals | `readModelCatalog()` queries the host’s SQLite schema and loads a module under `app.asar.unpacked`. A changed internal path can produce an empty picker on a new host version. Agent defaults still work. | Exercise present, absent and incompatible catalogs on the oldest supported and current host. Surface an “unsupported catalog on this version” state and prefer a versioned public API when available. |

Implementation references in the development repository: [worker recovery](../src/worker.ts), [panel refresh](../src/panel.tsx), [terminal discovery](../src/terminal-bridge.ts), [artifact writes](../packages/core/artifacts.ts), [model discovery](../src/model-catalog.ts).

## Publication hygiene

**Completed in this review**

- Made the default publication page English. The Russian guide links back to English. Kept the old English URL as a link to the canonical page. Added a persistent English/Russian switch to the Orca panel and isolated graph editor.
- Fixed the ignore pattern that omitted all 73 files in `vendor/yaml/dist` from Git. Compared all 73 JavaScript files and the license with the locked `yaml` 2.9.1 dependency. The parser is needed at runtime when installing from Git.
- Made the root MIT license a required build input. The release builder checks the editor and panel entry points, both documentation directories, the production source inventory, and vendored files. A release test follows links from the English landing page and checks the Russian return link.
- Documented the trusted-worker execution boundary, configured account access, project artifacts and optional external tools in the English guide. The manifest declares six host capabilities. The worker also has its OS user’s Node.js access.
- Separated the architecture document, this maintainer review, and the product improvement backlog. Development witnesses stay outside the installation tree.

**Before tagging**

1. Close the two high-priority findings and rerun their multi-run and out-of-order cases. Decide whether the terminal-history limit is acceptable for this release. If it stays, explain the limit in the public history UI.
2. Select a version and record release notes in English, including the language switch, required Orca version, access, migration and known limitations. Verify the root manifest, tag and intended GitHub owner. The candidate currently retains version 0.2.0.
3. Review the actual Git diff and all untracked runtime files. A tag on the current development HEAD would omit local changes. Stage the reviewed tree and compare the committed release inventory with the built directory. Keep test evidence, database files, account data, project fixtures and development builds out of the installation tag.
4. Use a fresh clone of the **actual tag** on a clean Orca profile. Validate, inspect and render that clone. Check first launch in English, switch to Russian, restart the host, open the graph editor, and upgrade a profile with saved drafts and run history. Exercise the minimum advertised Orca version and the current version. Record tested OS/host combinations.
5. Run one opt-in sandbox-project smoke with a configured provider, including an interrupted launch and recovery. Test optional Beads and GitHub functionality only where those features are advertised. Use an isolated test host for CI. Orca plugin tests execute trusted local code.
6. Publish the reviewed Git tree and matching tag under the intended publisher, add the `orca-plugin` topic and verify installation using the published tag. Generate a catalog entry from the committed release revision if distributing through a catalog. GitHub release notes should link to the English landing page and its Russian counterpart. [GitHub release documentation](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)

The installed Orca 1.4.261 CLI provides the distribution procedure via `orca skills get orca-cli --reference references/plugins.md`. Use `plugin inspect` to review access and file identity. Orca’s validator reported its 64-file host-call analysis bound on this candidate, so a passing manifest check covers only part of the import graph.

## Verification and scope

| Check | Result |
| --- | --- |
| TypeScript, plugin tests, render scenarios and editor static check | 224 tests passed, plus type checking and render checks on Orca 1.4.261. See `scripts/verify-ux.mjs publication-final`. |
| Standalone terminal type check and test suite | Passed, 110 tests. |
| Shared UX journeys | All 24 cases reran using the production panel and deterministic worker in Orca’s headless test host. This exercises the request contract with fixture responses. |
| Isolated editor localization | Headless Chrome executed the actual editor with an injected Orca settings/document bridge. English → Russian → English preserved an unapplied inspector edit and the exact document, and updated accessible names. |
| Source distribution | Constructed an isolated local Git snapshot from tracked and nonignored candidate files, cloned it, built the release, cloned the release tree separately, and ran Orca validate, inspect and check on the final clone. |
| Local installed candidate | The installed directory matched the separately cloned release tree (133 files, SHA-256 `995fb637a5d6e95e6cf0b230a08d7cd5f06aaf047800a8fa10056a1c3c9b9105`). In the live desktop panel, the saved six-step result opened in English. Selecting Русский immediately changed the controls and result heading and preserved the displayed run. The local profile was left in Russian. |
| Review witnesses | Isolated synthetic data reproduced the project-response race and the terminal-history cutoff. Multi-run recovery and the filesystem finding were traced in code. |

The current review did not exercise a published GitHub tag, other operating systems, the minimum Orca version, or live provider recovery. Previous desktop evidence and its test conditions are recorded in [the UX validation log](ux/validation.md).

[Architecture](architecture.md) · [Further improvements](improvements.md)
