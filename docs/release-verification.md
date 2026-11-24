# Release verification · Agent Pipeline 0.2.1

The five review findings and six improvement proposals were exercised against the same plugin ID used by 0.2.0. The public-facing [release notes](release-0.2.1.md) describe how to use the changes. The [architecture](architecture.md) explains ownership of runs, requests and files.

| Review item | What changed and how it was checked |
| --- | --- |
| Run isolation | Two attributed pending launches were created with distinct run and task identities. Repairing A left B’s original snapshot and pending receipt intact. A separately tested unowned receipt blocked repair before either run changed. Recovery checks the native dispatch ledger before retrying work. |
| Project switching | Reversed the completion order of A and B requests, once with a late success and once with a late failure. The selected project kept its tasks and errors. Changing project clears the prior dashboard data while the new request is outstanding. |
| Archive and selection | A cold SQLite fixture contained 151 runs with identical timestamps. Cursor paging returned every ID once, including the oldest. Filtering, case-insensitive Cyrillic search and an opened older run changing status were checked. A desktop upgrade fixture separately opened the oldest result across projects and displayed its original output. |
| Performance | On this macOS host, recent discovery of 150 synthetic runs with 32 kB of task data each took a median 6.23 ms on the 0.2.0 implementation and 6.00 ms on the candidate across 11 warm measurements. These figures cover the terminal bridge. Host project, account and tracker calls add time to the full dashboard. |
| Private attempt reports | Attempt reports, step state and checkpoints use an exclusive 0600 temporary file, sync and rename. Tests checked POSIX permissions, redaction, failed serialization preserving the previous bytes, and concurrent complete replacements leaving no temporary files. |
| Model availability | Exercised a missing database, incompatible schema or adapter, unavailable launch preferences, fresh per-account observations and supported effort intersection. Profile-specific cache paths take precedence over the OS default. Saved unavailable choices and agent defaults have separate states in the panel. |
| Narrow monitor | In the native macOS 1.4.263 renderer, assigned 320 and 480 CSS pixels of usable panel width. Opened the run selector, located recovery, opened the result and tasks views, and checked control bounds after scrolling into view. In all 16 locale/width/view combinations, scrollWidth equalled clientWidth and horizontal scroll offset was zero. |
| Keyboard graph | In an installed native editor, Tab and Enter started and completed a connection. Escape returned focus, a reverse edge produced a cycle error, and selecting and deleting the edge returned focus to the target input. The Chromium accessibility tree exposed a named edge button and a status region. The browser regression repeats the connection, cancellation and error flows in both languages. |
| Failed result | Exercised a nonzero and an unknown exit code on a partial run. Opening the attempt revealed the output. Opening its Orca session sent the recorded dispatch ID. Terminal-owned results show the available saved evidence. |
| Maintainability | Archive, result and status rendering live in separate modules. New model and attempt diagnostics carry typed IDs. Older stored diagnostics and original user text still render. The release builder checks the new modules and both language guides. |

## Verified candidate

| Gate | Evidence from 18 November 2026 |
| --- | --- |
| Release tree | 137 production files. The clean local tag clone, release builder output and installed plugin shared SHA-256 `e0f2cfc28b575704d5463741fc79298ef19eab6f1aa5b22d0776ffb444259aad`. The host grants matched 0.2.0. |
| Minimum host | On Orca 1.4.248, 238 plugin tests passed. Loaded the tagged source using the minimum CLI’s dev-load command, opened the native panel and selected both languages. |
| Current host | On Orca 1.4.263, 238 plugin tests passed. Type checking, panel render scenarios, editor checks and all seven packaging tests passed. The current CLI supports installation from a local folder. |
| Terminal | Type checking and all 110 tests passed. During a concurrent compatibility run, one three-worker fixture hit its 10-second timeout. The complete terminal suite passed when rerun separately. |
| Functional journeys | 24/24 headless journeys passed after each improvement. Desktop measurements additionally covered the 16 locale/width/view combinations. The installed editor passed actual keyboard input and accessibility-tree checks. |
| Installed profile | The worker reported version 0.2.1 running. A settled native capture showed the saved six-step result with zero pending requests or render errors. All six saved runs were present. Healthy and completed runs omit generic recovery guidance. |

## Desktop upgrade and storage

Installed 0.2.0 into a separate macOS Orca profile. The first panel was English. Entered an objective, chose Russian, and selected a paused terminal run in a fixture project. Upgraded the same plugin ID from the local tagged candidate tree. The selector retained the run and the language, the archive opened its oldest result, and **New run** restored the objective. All desktop fixture actions operated on temporary projects.

## Reproducing the checks

1. Use Node.js 22.19 or later and the Orca CLI for the host version under test. Run `node scripts/verify-ux.mjs release` for TypeScript, worker/panel regressions, render scenarios and the static custom editor check.
2. Run `node scripts/ux-e2e/run.mjs --headless` for 24 scenarios through the production panel and a deterministic worker. These cases ran after the recovery, project, history, artifact, model, reflow, keyboard and result changes. Scenario definitions and both cases per journey are in [the case map](ux/cases.md).
3. Run `node scripts/test-editor-language.mjs` with Chrome available, `npm run typecheck:terminal`, `npm run test:terminal` and `npm run test:release`. With Pi configured, `npm run build:terminal` followed by `node scripts/e2e-pi-dialogue.mjs --recover` exercises a real worker interruption in a disposable project.
4. Build from a clean local Git snapshot. In a separate temporary Git repository, commit the release builder’s output, tag it v0.2.1 and clone that tag. Compare the clone’s `orca plugin inspect` hash with the candidate folder, validate the clone and install the candidate. The development checkout and public refs are separate from this rehearsal.
5. For a desktop layout rerun, open a paused run with a failed check, set the panel content width to 320 and then 480 CSS pixels, and repeat in English and Russian. Check the run selector, recovery button, Results and Tasks inside the panel scroll container. For the editor, open a two-step YAML with no dependencies and run the keyboard sequence above.

The real Pi run completed after interrupting its process during the second question and recovering the saved session. The Beads test used the local bd executable to initialize a disposable repository, create a task, sync its status, comment and close it. The GitHub tests used deterministic PR/check/merge responses and treated the cancelled-check bucket as a failure. The merge command also transmits the approved SHA to protect against a race between inspection and merge. [GitHub CLI merge reference](https://cli.github.com/manual/gh_pr_merge) A live PR requires an authorized repository and an authenticated account.

## Integration with the public 0.1.3 release · 24 November 2026

The release incorporates repository YAML open/save, conflict detection, the expanded run preview, the failover simulation and Community screenshots from the published 0.1.3 history. Agent Pipeline now opens ordinary folders in place when restoring earlier panel state. The preview and the launch request use the same folder setting.

On macOS arm64 with Orca 1.4.263, a separate desktop profile installed the public v0.1.3 tag. Its panel saved a YAML file and a draft objective in a disposable project. A real run reached its approval gate and recorded a rejected decision. After the upgrade the Results view showed the original run and rejection, the objective was restored, and the saved file opened from `pipelines/`. Launching it again created a distinct run and gate in the same folder. The exercise intentionally stopped at the human approval step. The isolated test host’s CLI was routed to its own profile.

The standalone tarball also passed a clean installation outside the source checkout, with an offline executor and three separate checked steps. The desktop compatibility checks from 18 November describe the earlier candidate; the 0.1.3 migration above exercises the merged version.

## Publication and follow-up

The version tag carries the reviewed installation tree. The main branch carries the development sources and tests. Compare the fetched tag’s Orca content hash with the locally installed candidate, and publish the terminal tarball and plugin ZIP with checksums. Orca’s static validator limits host-call analysis to the first 64 files. The verification here covers macOS arm64.

For a first-user study, supply a project with one old completed run and one interrupted run. Ask the participant to find the older output, explain a blocked dependency and continue the interrupted run. Record completion, first correct action time, mistaken run selections, and whether completed work was duplicated. Ask a screen-reader user to create and remove a dependency with their usual setup. The desktop and accessibility checks above provide a baseline for this study.
