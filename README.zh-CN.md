# Agent Pipeline

[English](README.md) · [Русский](README.ru.md) · [简体中文](README.zh-CN.md)

Agent Pipeline 是一个 Orca 插件，可以让多个智能体按依赖顺序协作。例如，让 Codex 改代码并跑测试，再由 Claude 审查改动。你可以在图形编辑器或 YAML 中定义步骤，也可以把目标交给 Planner 生成草稿。有些步骤可以并行执行，也可以在发布前要求人工审批。

![Agent Pipeline 的图形编辑器与 YAML 草稿](https://raw.githubusercontent.com/Alexander-64/orca-pipeline/main/docs/images/scenario-editor.png)

## 安装

需要 Orca **1.4.248 或更高版本**，并确保终端能调用 `orca`。

```sh
orca plugin install Alexander-64/orca-pipeline@v0.1.2 --json
```

安装时，Orca 会列出插件申请的权限。确认后，运行提示中带 `--approve <fingerprint>` 的命令。插件需要读取智能体和工作区、启动协调器终端、读取插件设置，以及保存计划、运行记录和日志。插件以 `trusted-worker` 模式运行，Node 进程拥有当前用户的文件、网络和程序执行权限。Orca 列出的权限只约束插件对 Orca API 的调用。

在 Orca 中配置要用的智能体 CLI 和账户。使用远程主机时，也要在对应主机上配置。要用 Beads 跟踪任务，请在协调器所在的主机上安装 `bd`，在目标仓库运行 `bd init`，再打开 **Settings → Plugins → Agent Pipeline → Beads CLI executable**，填写 `bd` 或其绝对路径。

## 跑一次工作流

1. 打开 **Agent Pipeline → Scenario**，选中要修改的 **Workspace**。
2. 在 **Template** 中选 **Implementation → Evidence Gate**。用图形编辑器或 YAML 写清楚要改什么、怎么验收，将执行者设为 Codex，独立审核者设为 Claude。将示例里的验收命令换成项目实际使用的命令。
3. 点击 **Validate YAML**，打开 **Run preview** 核对步骤顺序、智能体、主机、工作树和验收命令。
4. 点击 **Start**，在 **Runs** 中查看进度、验收结果和每次尝试。已启用 Beads 时，可以在 **Beads** 中跟踪任务。

要把场景和代码一起纳入版本管理，请在 **Scenario** 中选择协调器所在主机上的工作区，展开 **Repository scenarios**，填写文件名并点击 **Save file**。文件会保存到该仓库的 `pipelines/` 目录。要修改已有场景，先通过 **Browse pipelines/ → Open file** 打开它。

## 配额用尽时如何续跑

可以为步骤设置按顺序尝试的备用智能体。确认当前尝试因配额失败后，协调器会停止这次派发，并把已有进度和验收要求交给下一位可用的智能体。运行详情会保留每次尝试。实时配额读取需要 `codex app-server`，其他提供商使用配置好的备用顺序。

![运行详情中的配额失败与备用智能体续跑记录](https://raw.githubusercontent.com/Alexander-64/orca-pipeline/main/docs/images/attempt-history.png)

[配额切换演示](examples/failover/README.md)用模拟环境重现 Codex 遇到配额限制、Claude 接手、Kimi 独立审核的过程，无需模型账户。

## 发布到 Orca Community

本仓库的[发布场景](pipelines/release.yaml)会锁定待发布的提交，让 Codex 构建并验证发布包、Claude 独立复核，然后等待人工批准。批准后才会向 GitHub 推送对应的版本标签，并在需要时添加 `orca-plugin` topic。使用该场景时，请在执行发布步骤的主机上登录 `gh`。

Community 从公开 GitHub 仓库读取根目录下的 v2 `orca-plugin.json` 和许可证，并按版本标签分发。发布后可查看[插件目录](https://orca.dev/plugins/alexander-64/orca-pipeline)中的收录状态。

## 本地开发

使用 Node.js 22+ 和 Orca 1.4.248+，在仓库根目录运行：

```sh
npm ci
orca plugin types . --json
npm run typecheck
npm test
npm run test:release
npm run check
npm run validate
```

边改边看面板，或构建发布包并验证其中的 manifest：

```sh
orca plugin dev watch . --check --shot .orca/shots --json
```

```sh
npm run build:release -- --out .release-smoke
orca plugin validate .release-smoke --json
```

[MIT 许可证](LICENSE)
