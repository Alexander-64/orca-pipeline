# Agent Pipeline

[English](README.md) · [Русский](README.ru.md) · [简体中文](README.zh-CN.md)

用于智能体 DAG 工作流的 Orca 插件：Planner 生成 YAML，Orca 通过 Run/Task/Dispatch 执行步骤，Beads 跟踪任务。步骤因配额问题而被确认失败后，协调器可以生成续接检查点并切换到下一个智能体。

发布者：[GitHub 上的 Alexander-64](https://github.com/Alexander-64)。许可证：[MIT](LICENSE)。

**0.1.2** 使用 manifest v2、`id: "agent-pipeline"` 和 `license: "MIT"`。已移除弃用的 `publisher` 字段：Orca 从 GitHub 仓库所有者推导发布者，安装键为 `alexander-64.agent-pipeline`。未声明 publisher 的本地文件夹使用 `local.agent-pipeline`。

## 从标签安装

0.1.2 标签发布后执行：

```sh
orca plugin install Alexander-64/orca-pipeline@v0.1.2 --json
```

需要 **Orca 1.4.248+** 及其 `orca` CLI。Orca 固定到标签的准确 commit。可执行插件需要审批：检查权限，同意后执行 Orca 返回的带 `--approve <fingerprint>` 的命令。`trusted-worker` 是独立的 Node 进程，以用户身份完整访问文件、网络和外部程序；capabilities 限制 Orca API 调用，并不隔离 Node 进程。

权限用途：`agent:read` 发现智能体，`workspace:read` 列出工作区，`terminal:send` 创建协调器终端，`storage:own` 保存计划、Run 和日志，`settings:own` 读取插件设置。一个 Agent Pipeline 面板包含四个内部视图。

在协调器主机安装并配置 `bd`，在目标仓库初始化 Beads（`bd init`）。在 Settings → Plugins → Agent Pipeline → Beads CLI executable 设置命令或绝对路径；bd 不可用时看板显示错误。在每个执行主机的 Orca 中配置外部智能体 CLI 和账户。实时配额读取需要 `codex app-server`，PR 操作需要协调器主机上已登录的 `gh`。插件不包含这些 CLI 或凭据。Node.js 22+ 和 `npm ci` 用于开发，从标签安装无需这些步骤。

## 使用仓库中的场景

在 **Scenario** 标签页选择协调器主机上的工作区。打开 **Repository scenarios → Browse pipelines/**，选择并打开 YAML 文件。**Save file** 将当前草稿保存到该工作区的 `pipelines/` 目录。要更新已有文件，请先打开它。如果磁盘上的文件已更改，请重新打开。

启动前展开 **Run preview**，可查看依赖顺序、首选与备用智能体、主机、工作树、人工审批、独立审查和验收命令。系统在派发步骤时根据当时的配额选择智能体。

仓库包含需要人工批准的[发布场景](pipelines/release.yaml)以及可复现的[配额故障转移演示](examples/failover/README.md)。

## 功能与界面

- 提供场景、执行、指标和 Beads 四个视图。模板、YAML 和可视化 DAG 编辑器共享同一份草稿；图中按依赖关系分波次展示步骤、智能体和审批门。
- 选择步骤卡片后，在检查器中修改字段和依赖，通过校验后应用。可以添加独立步骤或后续步骤、复制步骤、删除步骤（最后一个步骤除外）；删除时清理相关依赖。图上方可编辑场景名称和目标。
- 支持图、YAML、并排三种模式，重新打开面板时保留选择。并排模式使用自适应布局，两侧独立滚动，检查器位于下方。YAML 无效时保留最后有效的图，并暂停图编辑；验证和运行始终读取当前 YAML 草稿。
- Planner 卡片显示目标、智能体、running/done/failed 状态、Run ID 和错误；生成后显示名称、目标、步骤数和波次数。重新打开时恢复上次计划；已经应用过的结果不会覆盖后续手动修改。
- Planner、步骤执行者和审核者选择器使用 Orca 发现的智能体。保留自定义 ID，备用智能体通过复选框按选择顺序排列。
- 持久化变更日志结合 request ID、request-show 与 replay，在返回结果不确定时避免重复启动。Evidence Gate 支持独立审核，以及有次数限制的修复和再次审核循环。
- Handoff 2.0 和每次尝试的产物支持脱敏、大小限制和安全文件名。支持全局、提供商、主机并发限制、角色策略和基于配额的路由。
- 支持原生审批门、暂停/恢复/取消/重试及手动更换智能体；提供智能体指标和 Run 时间线。可选的 DAG 后 PR 流程等待 CI，只有获得审批且 head 未变化才允许合并。

## 要求与开发安装

需要 **Orca 1.4.248+**，PATH 中可用的 Orca CLI，以及用于开发和测试的 **Node.js 22+**。在 Orca 中配置所需智能体 CLI 和账户。协调器主机需要安装并配置 `bd`；在 Settings → Plugins → Agent Pipeline → Beads CLI executable 中设置命令或绝对路径。如果使用开发依赖中的版本，请指定 `node_modules/.bin/bd` 的绝对路径。PR 操作还需要协调器主机上的 `gh` 及其登录凭据。

在干净 checkout 的项目根目录运行：

```sh
npm ci
orca plugin types . --json
npm run typecheck
npm test
npm run test:release
npm run check
npm run validate
```

`npm ci` 根据 lockfile 安装开发依赖。`plugin types` 生成 tsconfig 所需、由 Git 忽略的 `.orca/types`。`typecheck` 检查类型；`test` 运行 Orca 插件测试；`test:release` 单独运行 Node 打包测试；`check` 渲染面板及 UI 场景；`validate` 校验源项目 manifest。test/check 会运行受信任的本地代码。交互式开发可使用：

```sh
orca plugin dev watch . --check --shot .orca/shots --json
```

Orca 可能要求用户批准 trusted-worker 执行权限。YAML 库及其上游许可证已包含在 `vendor/yaml` 中；Orca 直接加载相对导入，无需 bundler，也不需要在发布包中包含 node_modules。

## YAML 示例

```yaml
name: add-export
objective: 添加导出功能并通过测试验证
steps:
  - id: implement
    title: 实现功能
    spec: 在当前工作区实现修改
    agent: codex
    fallback: [claude, kimi]
    placement:
      host: local
      worktree: current
    acceptance:
      - npm test
  - id: review
    title: 独立审核
    needs: [implement]
    spec: 审核差异并重新运行测试
    agent: claude
    placement:
      host: local
      worktree: current
    acceptance:
      - npm test
```

请根据目标项目调整智能体 ID 和验收命令。依赖决定执行顺序；独立步骤可在容量限制内并行执行。如需 Evidence Gate，请在实现步骤设置与执行者不同的 `reviewAgent`；普通后续审核步骤本身不等同于该门控机制。

## 远程执行、故障转移与 Beads

远程步骤的 `placement.host` 是已保存的 Orca environment 名称。远程不允许 `worktree: current`；请使用精确工作区选择器，或使用 `new-top-level`/`new-child` 并提供 `placement.repo`。远程预检使用允许列表和只读命令策略。远程主机不可用时不会悄悄改为本地执行。

备用执行按配置顺序及容量/策略筛选智能体。确认配额失败后可将续接检查点交给下一次尝试；没有消息或启动响应不确定，不代表 worker 已退出。持久化日志支持查询及重放原始请求。Beads 提供搜索、筛选、领取、关闭、重新打开、epic 和状态同步；`bd` 不可用时会在看板中显示错误。

## 当前限制

Orca 通过 Task/worker_done 确认完成；验收命令由被分配的 worker 执行。独立复核请使用 `reviewAgent`。实时配额快照目前通过 Codex app-server 实现；其他提供商使用普通备用链。不支持同一提供商内切换账户：worker-start 无法逐次指定账户，而 account select 会修改全局配置。

PR 测试不会创建或合并真实 PR。Planner 和 pipeline 会在所选工作区中创建各自的协调器终端。插件以 trusted-worker 运行，通过无 shell 的 `execFile` 调用 `orca`/`bd`。本地测试不能证明真实凭据、远程连接或发布/合并流程一定可用。

## 发布包构建与验证

完成上述干净 checkout 检查后执行：

```sh
npm run build:release -- --out .release-smoke
orca plugin validate .release-smoke --json
```

最后一条命令验证实际发布目录，不安装或发布插件。`npm run build:release` 会用新构建替换默认的 `dist/agent-pipeline`，清除过时及仅用于开发的文件。构建先写入同级临时目录，替换失败时恢复原构建。`--out <path>` 指定其他目录，相对路径基于项目根目录；该目录必须尚不存在，只有标准的 `dist/agent-pipeline` 允许替换。如果默认目录正在用于已安装的插件或活动 Run，请改用新的 `--out`。

构建器仅使用 Node.js 内置模块，不执行 shell，也不增加依赖。它复制明确列出的生产模块、manifest、三个 README、存在时的根 LICENSE，以及包含上游许可证的 `vendor/yaml`。它校验相对导入与入口，验证 manifest 中声明的 PNG，拒绝符号链接、其他二进制内容和已知凭据模式。测试、fixtures、UI check 场景、包管理文件、node_modules、`.orca`、`.agent-pipeline`、日志、source map 及其他开发产物不会进入发布包。新增生产模块需显式加入 `scripts/build-release.mjs`。发布前仍须人工检查敏感信息，模式扫描无法保证发现所有秘密。`npm run test:release` 单独检查文件清单、与源文件逐字节一致，以及覆盖/符号链接防护。

## GitHub 与 Orca Community 发布

官方 Community 路径是一个**公开 GitHub 仓库**，仓库根目录必须有 **manifest v2 的 `orca-plugin.json`**。不声明 `publisher`：在 `engines.orca >=1.4.248` 下，Orca 从 GitHub 仓库推导所有者。根目录必须包含 **LICENSE**；项目使用 MIT，并保留 YAML 独立的上游许可证。发布树可包含声明的 PNG 截图，禁止包含可执行文件、原生模块、归档文件和符号链接。Orca 直接加载 TS/TSX 源代码。

已确认的仓库为 `https://github.com/Alexander-64/orca-pipeline`。检查文件及差异，运行上述完整验证。Manifest 必须位于仓库根目录，不能仅存在于 dist 中。保持 manifest/package 版本一致，为仓库添加 **`orca-plugin` topic**，再创建并推送对应版本的 **`v0.1.2` tag**。在 `https://orca.dev/plugins/alexander-64/orca-pipeline` 查看收录状态。**Community 不需要向 `stablyai/orca-plugins` 提交 PR。** 本地验证成功不代表 Community 已完成收录。

发布后，用户可执行 `orca plugin install Alexander-64/orca-pipeline@v0.1.2 --json`。可执行插件需要用户批准 Orca 列出的权限。package.json 中的 `private: true` 防止误发到 npm，不妨碍 GitHub/Community 分发。本说明不会创建仓库、commit、push、tag 或执行发布。

官方参考：[Orca 开发指南](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-authoring.md)、[manifest](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-manifest.md)、[收录说明](https://orca.dev/plugins/add) 和 [目录政策](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-listing-policy.md)。
