# Agent Pipeline

**English** · [Русский](README.ru.md) · [简体中文](README.zh-CN.md)

Plan a multi-agent task in Orca, see which steps can run together, and follow each agent through to its result. You can start with a template, ask a planner to draft a workflow, or open an existing `.pipeline.yaml` file.

**New in 0.4.0** · Reuse a parameterized scenario across projects, rehearse branches before launching agents, inspect handoffs, compare two results and review changes from an isolated Git run. [Release notes](docs/release-0.4.0.md)

![Agent Pipeline showing a recorded check in the Results view](assets/run-results.png)

## First run

1. Open **Agent Pipeline** and choose **New run**. Select a project and describe the task and its acceptance checks.
2. To reuse a team workflow, expand **Repository scenarios** in **Project**, browse `pipelines/` and open a YAML file. **Save file** writes the edited draft back to the same project. [Example release workflow](pipelines/release.yaml)
3. In **Steps and agents**, read the graph from top to bottom. Independent steps can start together. Select a step to edit its dependencies, primary agent, fallback order and optional reviewer. Model and effort choices come from the available Orca catalog.
4. In **Launch**, expand **Run preview** to inspect agent order, review steps and acceptance commands. Check the working folder. A separate Git workspace starts from the current commit. To include uncommitted changes, select the original working folder. Choose **Start run**.
5. Follow progress in the monitor. Select a step to open its agent session, answer a question or inspect a failed check. **View result** opens the final output. Partial results are available while a run is in progress.

Use the run selector at the top to return to another project’s history. Saved runs keep their original parameters. **New run** opens an editable draft. If a launch is unconfirmed, **Diagnose and continue** checks the launch journal and existing agent sessions.

The interface starts in English. Choose **Русский** in **English / Русский** at the top of the panel. Orca saves the preference for the panel and graph editor. Your YAML, step titles, agent replies and command output keep their original text.

## Reuse, rehearse and review

In **Project → Reusable scenarios**, select the audit template and enter a focus, such as the installation section of the README. **Create draft from template** opens the three steps in the editor. To save your own template, put parameters such as `{{focus}}` in the objective, a step title or its instructions, give the scenario a unique name and choose **Save draft as template**. The library persists across projects. `{{project}}` uses the selected project's folder.

In **Launch → Rehearse branches**, enter sample JSON outputs or mark a step as failed. The preview uses the execution engine’s condition and join rules and identifies manual approvals. The simulation assumes approvals are granted. During a real run, select a step and expand a handoff to see the previous report, the recorded reason, a checkpoint excerpt and both native sessions.

In **Results → Compare two runs**, choose a baseline, then open the other run from history. Expand a step to inspect changed report lines, recorded checks, file lists and the original step definition from each run.

For a Git project, launch into a separate worktree. After a successful run, **Results → Review worktree changes** previews the patch. Acceptance stages the reviewed files in the source project. The source must still be at the original commit and the affected paths must be clean. The standalone CLI supports the same flow for its local backend:

```sh
pipeline run -C ./repo -f plan.yaml --isolated ../candidate --watch
pipeline diff -C ./repo --isolated ../candidate --run RUN_ID
pipeline accept -C ./repo --isolated ../candidate --run RUN_ID --digest SHA256_FROM_DIFF
```

The copy starts at the source commit. Preview includes ordinary new, changed and deleted UTF-8 text files. Runtime directories, ignored new files and root `node_modules` are excluded. The review limit is 512 KiB. Git retains the copy for further inspection. You can inspect the staged result with `git diff --cached` before committing.

## Install

On Orca 1.4.263, install the versioned plugin from GitHub:

```sh
orca plugin install Alexander-64/orca-pipeline@v0.4.0 --json
```

Orca shows the publisher, version and requested access. Review the details, then use the approval command printed by Orca. On the minimum supported version, Orca 1.4.248, extract the plugin ZIP from the release and run `orca plugin dev load ./agent-pipeline`. [Download the release](https://github.com/Alexander-64/orca-pipeline/releases/tag/v0.4.0)

The trusted worker runs as your OS user, can open workspaces and terminals, and uses configured agent accounts. It reads the local model catalog to populate model choices. It stores run history and launch receipts in Orca plugin storage, and writes plan documents and attempt artifacts under `.agent-pipeline/` in the project. Review agent output and paths before sharing run data.

The built-in **Tasks** tab works without external tools. To sync issues with Beads, configure `bd` in your project and enable **External Beads tracker** under **Settings → Plugins → Agent Pipeline**. Workflows that explicitly request pull request operations require an authenticated `gh` CLI.

## Workflow example

```yaml
name: inspect-project
objective: Review the project layout and verify the findings
steps:
  - id: inspect
    title: Inspect the project
    spec: Summarize the project layout and cite the files you read.
    agent: codex
    acceptance: [git status]
  - id: review
    title: Verify the summary
    needs: [inspect]
    spec: Check the cited files and report inaccuracies.
    agent: claude
    acceptance: [git status]
```

## Architecture and development

The Orca panel and graph editor use a shared TypeScript DAG engine. The optional standalone terminal client uses the same engine with its own runtime and storage. The plugin can display terminal-owned runs and route commands back to their owning process. [Architecture and data flow](docs/architecture.md)

To develop the plugin or build the standalone client, use the main branch with Node.js 22.19 or later and the Orca CLI. [Development source](https://github.com/Alexander-64/orca-pipeline/tree/main)

```sh
npm ci
orca plugin types . --json
npm run typecheck
npm test
npm run check
npm run test:release
npm run build:release
orca plugin validate dist/agent-pipeline --json
```

For the standalone client, run `npm run build:terminal` and `node bin/pipeline.mjs --help`. Agent availability, login and remote execution depend on your environment.

Maintained by [Alexander-64](https://github.com/Alexander-64). Distributed under the [MIT license](LICENSE). The vendored YAML parser retains its [upstream license](vendor/yaml/LICENSE).
