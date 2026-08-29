# AI Agent 模式开发进度(交接文档)

更新:2026-08-29。配套设计文档:[ai-agent-mode-development.md](./ai-agent-mode-development.md)(下称"设计文档"),节号均指该文档。

## 1. 一句话状态

**阶段 1 + 阶段 1.5(自主探索能力)均已实施完毕,自动化验证全绿;等待用户在真实网关上做一次统一验收。**

自动化基线(本轮末实测):

| 检查 | 结果 |
| --- | --- |
| `cd src-tauri && cargo test` | 162 passed / 0 failed |
| `cd frontend && npx vue-tsc --noEmit` | exit 0,零错误 |
| `cd frontend && npm run test:scripts` | 64 / 64 |
| `cd frontend && npm run test:ui` | passed |

工作区状态:阶段 1 主体已提交于 `ae4ccba feat: add agent mode`;之后的命令层、UI、样式、「总是允许」修复与本轮阶段 1.5 均**未提交**。

## 1.5 本轮完成:自主探索能力(设计文档 10.2)

针对"Agent 只执行一条命令就收尾、不像 Claude Code 那样自主探索"的实测问题,按已确认的自主档位 **「只读自动 + 写操作审批」** 实施了 ①–④;⑤`update_plan` 工具按原计划留待效果验证后再评估。

| # | 改动 | 位置 | 生效值 |
| --- | --- | --- | --- |
| ① | 系统提示词重写:从"规则"改为"工作方式",新增自主推进、不停在第一个看似合理的结果、能查到的别问用户、证据不足时继续查;保留全部安全条款并说明只读自动执行/危险命令等审批。工具描述同步 | `domain/ai/agent.rs` `build_agent_system_prompt` / `run_command_tool_definition` | 9 条 |
| ② | 上下文预算放大 + 压缩策略改良:压缩后保留**退出码 + 输出尾部 300 字符**(原为整体丢弃),防膨胀保护保留 | `agent.rs` `MAX_AGENT_TURN_CHARS`;`lib/agentLoop.ts` `DEFAULT_MAX_TURN_CHARS` / `PROTECTED_RECENT_TURNS` / `COMPRESSED_OUTPUT_TAIL_CHARS` | 后端 80k、前端 72k、保护 6 轮、尾部 300 |
| ③ | 步数上限提升,收尾文案提示可续跑 | `agentLoop.ts` `DEFAULT_STEP_LIMIT` | 10 → 25 |
| ④ | 只读命令默认自动执行 | `AppShell.vue` `defaultUserSettings` | `agentAutoExecReadonly: true` |

**前后端预算是一对约束**:前端 72k < 后端 80k,保证长任务由前端先压缩,而不是后端直接 bail 报"任务轮次过长"。`production-ui-check` 已加断言锁死这个不等式,连同保护轮次 ≥6、步数 ≥25、默认自动执行、提示词关键词一并校验。

新增/更新测试:轮次压缩改测"保留退出码与尾部标记 TAIL-MARKER、最近 6 轮原样",新增"短输出不会因压缩而膨胀"(验证防膨胀保护);63 → 64。

## 2. 上一轮完成:UI 修复与「总是允许」缺陷

| 项 | 问题与修复 |
| --- | --- |
| **「总是允许」失效(功能 bug)** | 判定器要求**每一段**都被覆盖,按钮却只建议**第一段**。`memory_pressure \| tail -n 8; printf …` 点了「总是允许 memory_pressure」后 `printf` 段仍未覆盖 → 下次照旧弹审批。改:`classifyForAutoExec` 返回 `suggestedPatterns[]`(列出仍需补充的全部 pattern,已覆盖的段不列),循环侧 `execute-and-allow` 逐个落库;一票否决的命令返回空数组 → **按钮不再显示**(此前会显示一个点了也无效的按钮) |
| 命令输出被裁 | 输出块原用 `pre-wrap`+`word-break`,`df -h` 类表格折行即毁列对齐,再被 `.message{overflow:hidden}` 裁掉。改为 `white-space: pre` + 自带滚动容器 |
| markdown 文字越界 | `.markdown-content ul/ol` 是 grid,**grid 子项默认 `min-width: auto`**,含行内代码的长列表项撑破容器被裁。补 `min-width: 0` |
| 审批按钮溢出 | 窄面板放不下四个按钮。改为可换行;「总是允许」独立收缩 + 省略号(完整清单在 title);高风险二次确认从改按钮文案改为**按钮变红 + 独立提示行** |
| 步骤卡片信息 | `exit 0` 与状态标签相连 → 收进右对齐的 `.agent-step-meta`,并补上一直采集却未展示的 `durationMs`;新增「（无输出）」占位 |
| **模块化** | 新建 `components/AgentStepCard.vue`,卡片展示与审批交互整体迁出,AiPanel 只保留编排;5 个展示辅助函数随之内聚 |
| 回归护栏 | `production-ui-check.mjs` 新增 3 组断言:输出块禁用 `pre-wrap`、按钮必须可换行可省略、「总是允许」必须覆盖所有段。逐条验证非空转 |
| 新增测试 | `agent-auto-approve` 多段命令建议(直接复现用户上报命令)、`agent-loop` 多 pattern 落库;61 → 63 |

## 3. 阶段 1 实现明细(命令层 / UI / 设置 / 样式)

| 任务 | 交付 | 状态 |
| --- | --- | --- |
| B3+B5 命令层 | state.rs 四个允许列表包装(照 `save_ai_conversation_message` 模式);commands.rs 新增 `ai_agent_turn_stream`(照 `chat_with_ai_provider_stream` 模板,复用 ai-chat 流事件通道,`history_count: None`)与四个允许列表命令;lib.rs 显式 `use` 列表 + `invoke_handler` 均按字母序注册五项 | ✅ `cargo test` 全绿(84 单测 + 全部集成套件,18 个测试目标 0 failed) |
| F4 模式选择器 | AiPanel:props/emits 声明(与 WorkspacePanel 既有传参逐字对齐)、`panelMode`/`agentRunActive`/`composerBusy` computed、`selectPanelMode`(运行中禁切、切换即查可用性)、composer 左下分段控件、按模式变化的 placeholder、`composerPrimaryAction` 统一路由发送/停止、Ctrl+Enter 按模式分派、`sendMessage` 加 agent 模式早退保护 | ✅ 代码完成 |
| F5 任务驱动 + 步骤卡片 | AiPanel `startAgentTask`:任务-终端绑定(`boundTerminalId`)、组装 `AgentLoopDeps` 全部七个回调、每轮独立 requestId 并用 120ms 轮询把 `signal.cancelled` 传导为 `cancelTask`、`classifyStep` 三合一判定并在真正自动执行时 `touchAgentCommandAllowlistEntry`、`syncAgentRunToMessage` 终态写 `payloadJson`、完成时生成会话标题;模板:步骤卡片(状态/自动执行标注/风险 chip/敏感/exit code/理由/命令/输出/审批与超时按钮)、高风险二次确认(`agentHighRiskArmed`)、流式文本、任务状态徽标 | ✅ 代码完成 |
| F6 hydrate | AppShell `hydrateAiMessagePayload`:加载会话消息时解析 `payloadJson` 还原 `mode/agentSteps/agentStatus`,非 agent 或解析失败按纯文本降级 | ✅ 代码完成 |
| F8 设置区块 | SettingsSidebar:新增 `agent` 分区(shield 图标)、`agentAutoExecReadonly` 开关、内置集完整枚举(只读 chips + 危险参数说明)、允许列表表格(pattern/来源/命中统计/删除)、清空、手动添加(经 `validateAllowlistPattern`);AppShell:`agentAllowlist` 传参与 `deleteAgentPattern`/`addAgentPattern`/`clearAgentPatterns` 接线,`clearAgentAllowlist` 实现 | ✅ 代码完成 |
| 样式 | styles.css 追加约 480 行:`.ai-mode-switch`(对称于发送按钮的左下绝对定位)、`.agent-mode-notice`、`.agent-steps`/`.agent-run-status`/`.agent-step-card` 全套(按 status 变左边框色)、`.agent-action` 按钮组、设置区块样式,并配齐 `.theme-light` 覆盖(遵循文件既有 `.app-shell.theme-light X, .theme-light X` 双选择器约定) | ✅ 代码完成 |
| 文档同步 | 设计文档 6.4:`classifyForAutoExec` 签名更新为实际实现;分段器改为自包含(附不复用 `scriptExecution.ts` 的理由);一票否决补进程替换、危险环境变量前缀、历史展开;内置集清单整节重写为以 `BUILTIN_READONLY_COMMANDS` 为准并列出条目级禁用参数 | ✅ 完成 |

## 4. 完整实现清单(累计)

后端:`domain/ai/agent.rs`(协议层,18 单测)、`chat.rs`(仅 pub(crate) 可见性)、`domain/workspace/mod.rs` + `storage/schema.sql` + `storage/sqlite.rs`(两列迁移 + 允许列表表与 CRUD)、`app/state.rs` + `app/commands.rs` + `lib.rs`(命令层)、`tests/agent_storage.rs`。

前端:`types/agent.ts`(新)、`types/workspace.ts`(扩展)、`lib/agentLoop.ts`(新,16 测试)、`lib/agentAutoApprove.ts`(新,18 测试/171 断言)、`lib/shellIntegration.ts`(`armCommandCapture`,19 测试)、`lib/tauri.ts`(5 个 IPC 包装)、`components/TerminalPane.vue`(`runCommandAndCapture`/`agentCaptureSupported`)、`AiPanel.vue`、`AppShell.vue`、`WorkspacePanel.vue`、`SettingsSidebar.vue`、`styles.css`、`package.json`(测试套件)。

## 5. 统一验收清单(需真实模型网关)

自动化检查已全绿(见 §1)。以下为需要真实网关的人工验收,分三组。

### 5.1 自主探索能力(本轮新增,优先验)

这一组直接检验阶段 1.5 是否达到目的——判据是"像不像 Claude Code 那样自己往下查"。

| # | 操作 | 期望 | 不达标说明 |
| --- | --- | --- | --- |
| A1 | 提一个需要多步排查的目标,如「查一下是什么在占内存」 | Agent **连续自动执行多条只读命令**(ps / vm_stat / ls 等)不打断你,最后给出有证据支撑的结论 | 若仍只跑 1 条就收尾 → ① 提示词未生效或模型不遵循,记录实际模型名 |
| A2 | 观察 A1 的步骤卡片 | 只读命令带「自动执行」标注;整个过程你一次都不用点「执行」 | 若每条都弹审批 → ④ 默认值未生效(检查设置中心开关是否被历史配置覆盖) |
| A3 | 让任务持续到 10 步以上 | 不再在第 10 步停止;到 25 步才收尾并提示"可在下一条消息里让 Agent 接着排查" | ③ 未生效 |
| A4 | 长任务(10+ 条命令、输出较大)跑到后期,问 Agent「你前面第一条命令看到了什么」 | 仍能答出早期发现(压缩保留了退出码与输出尾部) | ② 压缩过度或预算未生效 |
| A5 | 同上长任务 | **不出现**"任务轮次过长"错误 | 前后端预算不等式被破坏(前端应先压缩) |
| A6 | 观察 token 用量/网关账单 | 单轮请求明显变大属预期;若网关报单请求超限,需下调 `MAX_AGENT_TURN_CHARS` / `DEFAULT_MAX_TURN_CHARS`(保持前端 < 后端) | 已知风险,见设计文档 10.2 风险栏 |

### 5.2 安全姿态未被放宽(回归,必验)

放开自主性后**必须确认这些仍然拦得住**:

1. `rm -rf` 等高风险命令仍停下等审批,且需二次确认(按钮变红 + 提示行)
2. `sudo` 开头、`cat a > b`(写重定向)、含 `$( )` 的命令**不自动执行**,且不显示「总是允许」按钮
3. 敏感命令(如 `cat ~/.ssh/id_rsa`)始终人工审批,不提供「总是允许」
4. 破坏性操作前 Agent 仍先用只读命令确认目标(提示词第 5 条)
5. 命令被跳过后 Agent 换思路,不原样重发(提示词第 7 条)

### 5.3 阶段 1 基础功能(设计文档 10.1)

1. 模式切换与会话级持久化(切到 Agent、重开应用仍是 Agent)
2. 审批执行闭环:模型提命令 → 卡片 → 执行 → 输出与退出码回传 → 下一步
3. 跳过与停止(模型请求中 / 等审批 / 执行中三个时机各试一次)
4. 命令超时后「继续等待 / 停止任务」
5. 「总是允许」:对**多段命令**(如 `memory_pressure | tail -n 8; printf 'x'`)点一次后,同类命令下次应自动执行——上一轮修复的正是此处
6. 设置中心可见允许列表来源与命中统计,删除后恢复人工审批
7. 不支持 tools 的网关给出明确报错与切换建议
8. 命令输出为表格(`df -h`)时列对齐不被破坏,超宽可横向滚动

**回归重点**:普通对话模式行为应与改动前完全一致(发送、停止、命令点击执行、会话标题、上下文压缩)。

## 6. 注意事项

1. **本轮未提交任何 git commit**(按既有约定待用户指示)。
2. `AgentCommandHandle.cancel` 只放弃等待、不 kill 命令;超时逻辑在 agentLoop 侧。
3. 命令不匹配检测中,捕获命令为空串视为"未知",不判串扰(无 633;E 的远端 shell 兜底)。
4. agent 消息的 `mode/agentSteps/agentStatus` 是运行时字段,仅 `payloadJson` 落库,靠 §3 的 hydrate 还原。
5. Agent 模式要求终端有 shell integration 语义标记(`sawMarkers`),否则 `agentAvailabilityCheck` 返回提示且不允许发起任务——本地 zsh/bash 自动注入,**远端 SSH 需 shell 自行上报 OSC 133**,哨兵兜底属设计文档 10.3 阶段 2。
6. Rust 侧依赖 serde 的 `rename_all_fields`(≥1.0.186),勿降级。
7. **前后端轮次预算是一对约束**:前端 `DEFAULT_MAX_TURN_CHARS`(72k)必须小于后端 `MAX_AGENT_TURN_CHARS`(80k),否则长任务会由后端 bail 报错而非前端压缩。改动任一侧都要同步另一侧,`production-ui-check` 有断言把关。
8. `agentAutoExecReadonly` 默认已改为 `true`。若本地 `localStorage` 里存过旧设置(值为 `false`),合并时会沿用旧值——验收 A2 不通过时先查设置中心开关。
9. 阶段 1.5 的 ⑤`update_plan` 工具**未实施**,按计划等 ①–④ 效果验证后再评估是否需要。
