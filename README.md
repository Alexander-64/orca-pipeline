# Agent Pipeline

[English](README.md) · [Русский](README.ru.md) · [简体中文](README.zh-CN.md)

Agent Pipeline lets you give a coding task to one agent in Orca and have another check the result. For example, Codex can fix a CSV export bug and run the tests. Claude then reads the diff, reruns the checks and reports what it found. You can watch both steps in the same panel and save the workflow as YAML for the next bug.

![The editor shows Research and Design running in parallel, with their YAML alongside](https://raw.githubusercontent.com/Alexander-64/orca-pipeline/main/docs/images/scenario-editor.png)

## Install

Install with the CLI included in Orca **1.4.248 or later**.

```sh
orca plugin install Alexander-64/orca-pipeline@v0.1.2 --json
```

Orca will show the permissions and a command containing `--approve <fingerprint>`. Review them before running that command. Agent Pipeline runs as a trusted Node.js worker under your account, with access to your files, the network and external programs. Through Orca it lists agents and workspaces, opens coordinator terminals and stores its settings and run history.

Sign in to the agent CLIs you plan to use on each execution host. For the Beads board, install `bd` on the machine running the coordinator and run `bd init` in your project. If Orca can’t find it, set the full path under **Settings → Plugins → Agent Pipeline → Beads CLI executable**.

## Try a change and a review

1. Open **Agent Pipeline → Scenario**, select your workspace and choose the **Implementation → Evidence Gate** template.
2. Select the implementation step and give it a concrete task, such as “Fix CSV export so a comma inside a quoted field stays in that field.” Set the acceptance command to the test command your project actually uses. Choose the implementing agent and a different review agent, then click **Apply step**.
3. Open **Run preview** to see who will do the work, in which worktree, and what each agent will check. Click **Start** when the plan looks right.
4. In **Runs**, select a step to see its attempts and output. The reviewer can accept the change, request a fix and another review, or report a blocker.

The map and YAML editor share one draft. To reuse it, open **Repository scenarios**, enter a name such as `csv-export.yaml`, and click **Save file**. The file goes in the selected workspace’s `pipelines/` directory on the coordinator host. To edit one that’s already in Git, choose **Browse pipelines/** and **Open file**. If the file changes on disk while you’re editing, reopen it before saving.

## When an agent hits its limit

If a step has fallback agents and Orca confirms that the current attempt ended on a quota limit, the coordinator can pass the work to the next eligible agent. The next agent receives a checkpoint with the previous attempt’s output and the checks it still needs to verify.

![Attempt history in a simulated run: Codex stopped on quota and Claude completed the retry](https://raw.githubusercontent.com/Alexander-64/orca-pipeline/main/docs/images/attempt-history.png)

In the simulated run above, Claude finishes the release notes after Codex hits its limit. Kimi then reviews the change. You can reproduce the handoff locally and read the checkpoint. [Run the failover demo](examples/failover/README.md)

## For a larger workflow

In YAML, `needs` sets the order of steps. Independent steps can run in parallel, subject to the limits you set for agents and hosts. Use `reviewAgent` to add an independent review, or `approval` to pause a step for a human decision. The release workflow in this repository shows how to test a Git commit, review it, and ask for approval before pushing its tag. [Read the release scenario](pipelines/release.yaml)

<details>
<summary>Example YAML</summary>

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

Replace the agent IDs and test commands with ones available in your project. For a remote step, set `placement.host` to a saved Orca environment. Use an exact worktree selector, or choose `new-child` or `new-top-level` and set `placement.repo`.

</details>

<details>
<summary>Development and release checks</summary>

Use Node.js 22+ and the Orca CLI. Run these commands from a clean checkout.

```sh
npm ci
orca plugin types . --json
npm run typecheck
npm test
npm run test:release
npm run check
npm run validate
```

Use watch mode to reload the panel as you edit it.

```sh
orca plugin dev watch . --check --shot .orca/shots --json
```

To check the files that will ship, build into a fresh directory and validate it.

```sh
npm run build:release -- --out .release-smoke
orca plugin validate .release-smoke --json
```

The default build replaces `dist/agent-pipeline`. Choose a fresh `--out` path if a running plugin uses that directory. The release includes the YAML runtime and its upstream license. For workflows that create pull requests, sign in to `gh` on the coordinator host. Live quota checks for Codex use `codex app-server`.

</details>

[Orca Community listing](https://orca.dev/plugins/alexander-64/orca-pipeline) · [MIT license](LICENSE)
