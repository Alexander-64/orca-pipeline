# Native UX journeys

Runs the production panel through Orca's real components renderer and IPC, with a dedicated deterministic worker in a temporary plugin folder. This exercises UI wiring, not LLM correctness or the production coordinator's process lifecycle. Existing coordinator/runtime tests cover the latter separately.

The fixture has its own key `alexander-64.agent-pipeline-ux-e2e`, no host capabilities, no access to production plugin storage, and no terminal/network calls. Test-only reset events and a capture button are inserted into the copied panel. They are never added to the production panel or release inventory.

1. `node scripts/ux-e2e/run.mjs --prepare` creates and loads the isolated copy. An exact-key approval is handled for the trusted local test code only, and the runner asserts that no host capabilities were requested.
2. Hide/minimize Orca using its UI. Automated native actions are intentionally refused in a visible window.
3. `node scripts/ux-e2e/run.mjs --existing` runs cases and then unloads the test copy and reopens the real plugin.

Evidence: `.orca/ux-evidence/native/summary.json`, per-case state/request JSON, and PNGs. Capture errors/timeouts are failures, not passes. Never reuse a timed-out act blindly: inspect the worker observation and running processes first. The runner stops on infrastructure timeouts or window-visibility refusal.

The synthetic snapshot only observes panel atoms after user actions. Assertions must inspect the relevant domain state or worker input as well; just receiving a screenshot is not a successful test.

## CUA fallback (verified)

When Orca's screenshot RPC times out, keep the prepared copy open and use the CUA app API for actual clicks/selects/typing. For each case:

- `node scripts/ux-e2e/run.mjs --existing --configure S01-1` prints its native actions and resets only the fixture panel.
- Execute those actions in the actual fixture panel, observe the UI, then press **E2E capture**.
- `node scripts/ux-e2e/run.mjs --existing --check-case S01-1` asserts the captured state and exact worker inputs and writes a `.cua.json` witness.

Repeat for all 24 IDs. CUA must read current AX state after each action; never reuse stale indices. Some inspector controls need scrolling into view; a Link's AX press can fail, so use observed screenshot coordinates when needed. S08-2 uses a native double click with a delayed worker response to verify a single repair request. S01-2 also reloads the panel and captures again to prove persisted selection.

`--audit-cua` rechecks saved assertions only; it does not drive the UI or constitute a fresh e2e run. The 24 current witnesses were produced by real CUA actions, not a headless mount test. Remove the fixture afterwards and reopen the original plugin.

## Headless release regression

Run `node scripts/ux-e2e/run.mjs --headless` to execute the same 24 case definitions in Orca’s test host. The driver mounts the production panel and deterministic worker without loading a plugin in your open Orca window. It records fresh results in `.orca/ux-evidence/native/headless.log`. Desktop shots and CUA runs exercise the native renderer separately.

Run `node scripts/test-editor-language.mjs` for the isolated editor in a headless browser. The test switches EN → RU → EN while an unapplied inspector edit is present. Set `CHROME_BIN` to a Chromium executable if the platform default is unavailable.
