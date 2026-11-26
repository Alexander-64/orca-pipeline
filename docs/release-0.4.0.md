# Agent Pipeline 0.4.0 · Reusable workflows and reviewed changes

- Save a scenario in the panel’s template library and fill in its parameters for each project. The included three-step workflow audits a selected area, proposes improvements and independently reviews them.
- Rehearse a conditional workflow from Launch. Supply hypothetical typed results and failures to see which steps execute, which skip and where approval is needed.
- Expand a handoff in the monitor for the reason, previous output, prepared checkpoint excerpt and links to both native agent sessions. Older attempts retain the evidence originally recorded.
- Pin a baseline in Results and open a second run from history. Compare step definitions, added and removed report lines, recorded file changes and acceptance results.
- Review a completed isolated Git run and stage its patch in the original project. Local console users can use `pipeline run --isolated PATH`, `pipeline diff` and `pipeline accept --digest HASH`. Acceptance checks the reviewed patch, original commit and affected source files. Text patches up to 512 KiB are supported.

Install the plugin with `orca plugin install Alexander-64/orca-pipeline@v0.4.0 --json`. For the standalone client, download the attached tarball and run `npm install -g ./orca-agent-pipeline-0.4.0.tgz`.

[README and first-run guide](https://github.com/Alexander-64/orca-pipeline/blob/v0.4.0/README.md) · [Русское руководство](https://github.com/Alexander-64/orca-pipeline/blob/v0.4.0/README.ru.md) · [Примечания к выпуску на русском](https://github.com/Alexander-64/orca-pipeline/blob/v0.4.0/docs/release-0.4.0.ru.md)
