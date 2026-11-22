# Simulated quota failover and independent review

The demo runs Agent Pipeline's real Coordinator against a fake Orca host and in-memory Beads client. The host scripts agent output, task statuses, and the review verdict. The demo uses no model accounts, network calls, actual quota exhaustion, source edits, or release operations.

From a source checkout with the Orca CLI and Node.js 22+ available, run:

```sh
npm ci
npm test
```

Find the `simulated quota failover sends a checkpoint` test in the suite output. It prints the continuation checkpoint and verifies the dispatch sequence:

1. Codex's turn ends after reporting a usage limit and partial work in `CHANGELOG.md`.
2. The Coordinator stops the Codex dispatch and retries the same task with Claude. Claude receives a continuation checkpoint with the previous output and the acceptance check.
3. The fake host reports that Claude completed the edit. A separate Kimi task runs the Evidence Gate and the fake host reports `SHIP`.
4. The Coordinator starts the downstream release-summary task after the Evidence Gate completes.

To regenerate the screenshots from the source checkout, minimize the Orca desktop window and run:

```sh
orca plugin shot . --scenario split --theme dark --width 1280 --out assets/pipeline-planner.png --json
orca plugin shot . --scenario failover --theme dark --width 1280 --out assets/quota-failover.png --json
```

The `failover` capture replays the demo's completed run in Orca. Select the implementation step in an interactive run to view its two attempts. The command-line test prints the actual checkpoint sent in the simulation.
