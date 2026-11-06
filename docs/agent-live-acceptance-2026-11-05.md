# Agent 本地终端与 SSH 真机验收记录（2026-11-05）

本轮使用用户指定主机及应用中已保存的直连 SSH 配置。主机地址、凭据引用和密钥不写入仓库。客户端为 macOS，远端为 Linux、OpenSSH 9.6p1、Bash 5.2.21、Python 3.12.3。原配置 SQLite 只读打开，只有选中的连接和模型行复制到权限受限的临时数据库；系统凭据接口只允许读取，沿用应用的主机密钥校验。

所有文件写入位于新建的 `/tmp/ai-term-m5-<随机值>` 或 `/tmp/ai-term-m5-model-<随机值>`。测试没有修改 SSH/Shell 启动配置、安装软件或操作业务服务。每次运行结束清理确切的测试文件，再用 `rmdir` 删除空目录；不递归删除未知内容。

| 验收路径 | 实际结果 |
| --- | --- |
| 应用原生独立 SSH exec | 登录通过；标准输出和错误输出分离；真实非零退出码 7；审批只消费一次 |
| 交互 SSH + 会话 Shell 集成 | 固定探针证明完整输出和退出码；不修改远端启动文件 |
| 协商后的多行原样输入 | 空行、注释、中文和 Tab 保留；整段最终退出码 9；`cd` 在当前 Shell 中生效 |
| 真实 SSH 流重放到浏览器 xterm | 分片输入后仅生成一个完整结果；历史命令与已审查原文逐字一致 |
| SFTP 文件闭环 | 当前终端与 SFTP 环境核对后读取；精确补丁、重新读取、恢复和再次核对通过；外部改动使旧补丁冲突 |
| 关闭 SFTP 的当前终端文件闭环 | 在临时配置副本中关闭 SFTP；同样的读取、修改、恢复及冲突流程通过 |
| 默认模型 `gpt-6-astra` | 真实读取和一次批准后的补丁写入成功；下一轮网关返回 `Upstream response stream was interrupted`，未通过完整闭环；停止后清理，没有重放写入 |
| 已配置模型 `deepseek-flash` | 4 轮完成真实读取、精确补丁、再次读取和核验；3 次工具调用、1 次写入；原生端独立确认最终全文，清理完成；用时约 84 秒 |

## 真机发现与修复

原生文件服务最初共用 20 秒观察时限。SFTP 写入需要按顺序核对环境、路径、完整内容、元数据和写后结果；本次公网连接的单次成功修改需要约 30 秒，恢复约 27 秒。原时限导致写入回执显示未知，并取消后续观察。

现将原生文件编辑的观察时限设为 60 秒，前端 IPC 等待设为 65 秒；读取仍为 20 秒。完整复核、取消、持久回执和单次派发约束保持有效。超时不是成功证据，也不会触发另一提供方或自动重试。回归测试覆盖超过原 25 秒前端等待仍接收成功回执、65 秒后保持未知且不重放、后端慢操作及及时取消。

本批验证：前端关联测试 573/573、AI 测试 275/275、架构 4/4、UI 契约和构建通过；Rust 全量 343 项通过、25 项默认忽略（含 3 项显式真机测试），`cargo check`、格式检查及工作树空白检查通过。真机 SFTP 闭环约 153 秒，当前终端回退约 27 秒。实际环境回放到 xterm 的浏览器断言通过，截图已检查。构建仍有既有的大 chunk 提示。

## 复验入口

`src-tauri/tests/live_acceptance.rs` 中所有真机测试默认忽略。必须显式指定本机数据库、保存连接 ID 和预期主机，防止误用其他配置。不要在命令行放口令或 API key。

```sh
export AI_TERM_LIVE_DATABASE='/absolute/path/to/ai-term.sqlite3'
export AI_TERM_LIVE_PROFILE='saved-connection-id'
export AI_TERM_LIVE_HOST='explicitly-authorized-host'
cargo test --manifest-path src-tauri/Cargo.toml --test live_acceptance live_ssh_read_only_preflight -- --ignored --nocapture

export AI_TERM_LIVE_WRITES=temporary-directory
export AI_TERM_LIVE_REPLAY=/tmp/ai-term-live-replay.json
cargo test --manifest-path src-tauri/Cargo.toml --test live_acceptance live_shell_capture_and_file_edit_restore -- --ignored --nocapture

AI_TERM_LIVE_FILE_PROVIDER=current-terminal cargo test --manifest-path src-tauri/Cargo.toml --test live_acceptance live_shell_capture_and_file_edit_restore -- --ignored --nocapture

export AI_TERM_LIVE_MODEL='saved-model-config-id'
cargo test --manifest-path src-tauri/Cargo.toml --test live_acceptance live_model_reads_patches_and_verifies_fixture -- --ignored --nocapture
```

模型测试最多 8 轮、12 次工具调用；只接受目标文件的读取和唯一指定替换。原生后端生成差异后，测试再次核对路径及完整前后内容，再消费一次审批。它直接调用生产模型协议和原生文件服务，不是模型模拟，也不代表完整 Tauri UI 自动化。

运行 Vite 和 Chrome CDP 后，设置 `AI_TERM_CAPTURE_REPLAY_FILE` 为真实 SSH 回放文件，执行 `npm --prefix frontend run test:bracketed-capture-browser`。回放文件含测试命令、随机临时路径和远端提示符，应留在本机。

## 尚未覆盖的环境

本轮真机只覆盖一条 Linux/Bash 直连路径。远端 Zsh/旧 Bash、提示符主题、跳板与交互菜单、提权及容器、Windows 客户端、远端 macOS，以及真实业务配置检查/重载仍不能标为真机通过；相应本机、隔离协议与 UI 替身结果见主实施方案。整体 M0—M11 要求已在后续核对中完成适用实现与测试，M10 的文件操作、受支持复杂 Bash 和命令凭据外部输入模板已补齐；独立 SSH 环境和元数据恢复等不可直接转换的步骤会逐项保存待整理来源。上述脚本扩展未在本轮真机验收中宣称通过。

## macOS 本地终端补充验收

用户确认本机 macOS 可供本地终端验证后，复验实际环境：macOS 27.0.1（26A434）、arm64、系统 Zsh 5.9、系统 Bash 3.2.57、Python 3.13.5；另使用此前在临时目录编译的 Bash 5.2.37。测试创建真实 PTY 和交互 Shell，调用生产命令意图及原生文件接口；使用干净 Shell，不读取用户启动文件或写入历史，文件与数据库都在独立临时目录中。

| 本地验收路径 | 实际结果 |
| --- | --- |
| 系统 Zsh / Bash | `shell_capture_integration` 6/6；真实退出码、重复加载、已有提示符钩子和文件读取通过；系统 Bash 3.2 明确使用兼容回退 |
| Zsh / 现代 Bash | 指定 Bash 5.2.37 后同套件 6/6；多行输入的空行、Tab、中文与源码历史保留，最终退出码准确；目录和变量在当前 Shell 中持续有效 |
| 真实 PTY 流 → 浏览器 xterm | 两个 Shell 的流分别分片回放，每段只有一个捕获结果，历史源码逐字一致，退出码 9；浏览器断言与截图检查通过 |
| 实际环境探测 → 本地文件提供方 | `local_acceptance` 1/1，内部依次运行 Zsh 和系统 Bash；从真实终端探针取得账号、目录与环境证据，文件接口选中 Local 提供方 |
| 原生文件修改与恢复 | 两个 Shell 均完成读→精确差异→单次批准→写→再读→重新审批恢复；BOM、CRLF、Tab 及含引号/中文路径逐字节核对；未批准和重复派发拒绝；外部修改使旧提案冲突；关闭终端后 SQLite 仍保留原始变更记录 |

原样派发保留交互 Shell 的既有选项。默认 Zsh 未开启 `interactivecomments` 时，`#` 行会出现 `command not found: #`；真实回放如实包含该输出，测试没有把它当成成功执行的注释，也没有替用户修改选项。最终退出码仍是整个输入程序的最终状态。

复验命令：

```sh
cargo test --manifest-path src-tauri/Cargo.toml --test shell_capture_integration -- --nocapture
AI_TERM_TEST_BASH='/path/to/bash-5.2.37/bash' AI_TERM_CAPTURE_REPLAY_FILE=/tmp/ai-term-macos-replay.json cargo test --manifest-path src-tauri/Cargo.toml --test shell_capture_integration -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --test local_acceptance -- --nocapture
AI_TERM_CAPTURE_REPLAY_FILE=/tmp/ai-term-macos-replay.json npm --prefix frontend run test:bracketed-capture-browser
```

原始输出留在本机 `/tmp/ai-term-m5-macos-shell-system.log`、`/tmp/ai-term-m5-macos-shell-modern.log`、`/tmp/ai-term-m5-macos-local-native.log` 和 `/tmp/ai-term-m5-macos-replay-browser.log`。本地文件闭环约 29 秒。同期任务计划修复后的完整回归为前端关联 594/594、AI 282/282、Rust 356 项通过及 25 项默认忽略，构建、架构、UI、格式和空白检查通过。本地原生和 xterm 回放分别验证，不宣称完成了整个 Tauri UI 的真实模型自动化，也不替代远端 macOS SSH 或 Windows 客户端验收。

## 根挂载修复后的 SSH 复验

Linux 等价判断增加唯一可见根挂载条目摘要后，原授权直连环境仍选中 SFTP。真实读取、批准后的精确补丁、写后读取、恢复及外部改动冲突全部通过，耗时约 175 秒；两次成功写入各约 36 秒，仍在既有 60 秒观察时限内。关闭 SFTP 的临时配置副本选中 CurrentTerminal，同流程约 25 秒通过。真实多行流再重放到 xterm，通过中文/Tab、原始源码历史及最终退出码 9 断言。

原始输出：`/tmp/ai-term-m3-root-proof-live.log`、`/tmp/ai-term-m3-root-proof-fallback.log`、`/tmp/ai-term-m234-complete-replay-browser.log`。隔离 SFTP 额外证明根挂载不匹配或根条目不可见时，在读取目标正文前拒绝使用原等价许可；不能据此声称已实测所有远端 chroot/容器。

## 本机配置、重载、中断恢复与脚本联合验收

新增 `local_acceptance/workflow.rs`，在本机创建临时配置、数据库和仅监听 `127.0.0.1` 随机端口的 Python HTTP 服务。真实 Bash PTY 通过生产 AppState 操作意图、文件服务、检查点和知识接口；Node 调用生产 TypeScript 结果验证及任务脚本转换函数，输入是实际保存的检查点和文件回执。

1. 保存并按实际目标读取配置路径知识，建立读取、修改、检查、重载、验证计划。
2. 完整读文件，核对精确前后内容，批准补丁并保存文件回执；实际语法检查输出 `CONFIG_OK`。此时服务仍返回旧配置，证明写文件本身不代表重载生效。
3. 通过已审核命令向本次测试子进程发送 HUP，模拟命令已经执行、回执未落库后丢失原终端和 AppState。服务和数据库继续存在。
4. 新建真实 PTY，重新探测环境并恢复原 runId。旧意图无法派发，缺少新证据时不能确认恢复；完整读取当前服务状态，确认同一测试 PID、`generation=1` 和新配置后才允许继续。
5. 受控实际 HTTP 请求取得 `HTTP 200 response=after generation=1`；生产验证函数据此判定已验证，未知重载保留原历史并关联恢复证据，没有伪造退出码或再次重载。
6. 生产脚本转换选择文件修改、配置检查和 HTTP 验证，生成参数草稿并经原生 SQLite 保存/重开，runId 和步骤来源一致。原重载因回执未知明确列为待整理来源；草稿不声称包含完整可重复部署流程，也未自动执行。
7. 重新审批恢复配置文件，实际文件还原，而服务仍使用新配置且 `generation=1`；恢复文件不表示撤销服务重载。测试子进程和临时目录已清理。

显式联合用例 1/1，通过，耗时约 8 秒，日志 `/tmp/ai-term-joint-local-workflow.log`。它验证实际进程与原生/TypeScript 证据链；完整 AI 和终端 UI 浏览器另有覆盖，但浏览器使用 IPC 替身。本记录不把私有 HTTP 服务说成 nginx，不把该测试说成真实模型驱动的完整 Tauri UI 自动化，也没有操作任何业务服务。

复验需要 Python 3、curl、Node 和已安装的前端依赖，默认忽略：

```sh
cargo test --manifest-path src-tauri/Cargo.toml --test local_acceptance private_service_config_reload_recovery_verification_and_script_source -- --ignored --nocapture
```

最终代码回归：前端关联 644/644、AI 313/313、Rust 363 项通过和 26 项默认忽略；新增联合用例已显式单独 1/1 通过。构建、架构 4/4、UI、格式、编译和空白检查通过；完整 AI、主机知识、终端调试及真实流重放浏览器通过。完整索引见 [要求核对](agent-completion-audit-2026-11-05.md)。
