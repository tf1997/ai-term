# SFTP 评审整改与验收

2026-09-15：原评审的 12 项待办已完成实现和验收。续接会话 `01a0a0a5-e598-7c20-8be7-9c80dddf44a4`，基线提交为 `19ab4b6`。原评审及 18/40 分数保留为历史基线，未将自动化测试通过率换算成新的设计评分。

## 逐项验收

| 评审项 | 已实现的行为 | 验证证据 |
|---|---|---|
| 1 身份识别 | 先检查提示符与未执行输入；实际发送成功才接受结果；识别 12 秒截止，可取消、重试；隔离旧标记和其他终端输出 | `connection.test.mjs` 覆盖缺标记、缺 IP/账号、无输出、发送失败、取消和并发识别；浏览器实际等待 12 秒超时后重试 |
| 2 多地址 | IPv4/IPv6 过滤、规范化和去重；优先上次成功地址；依次尝试；逐地址显示网络、认证、主机密钥等原因 | 领域测试及浏览器多地址故障转移、全部失败、重新连接验证 |
| 3 后台任务 | 独立任务队列固定来源、目标、账号和路由；A/B 切换及关闭文件视图不会取消 SFTP；全局显示归属、进度、速度、剩余时间、取消和结果 | `tasks.test.mjs`、浏览器 A 上传 → B → A、排队取消及全局任务中心验证 |
| 4 目录现场 | 每个访问过的终端独立保留面板；每目标保存两侧路径、历史、选择、滚动、搜索、排序、路径草稿和传输方式；偏好按服务器/账号保存 | `browser-state.test.mjs`；浏览器 A/B 双方状态恢复和页面重载测试 |
| 5 快捷路径 | 同目标重新检测保留目录；首次优先终端 cwd；提供独立“终端目录”、收藏、最近访问、路径补全和命名路径组合 | 浏览器重检前后历史比较、独立 cwd 定位、路径组合/收藏/补全及重载验证 |
| 6 目标绑定 | 返回文件页及写入前核对终端身份；编辑器和操作固定原目标。配置端口/网关变化后，后端拒绝旧任务；编辑草稿保留 | `remote-editor.test.mjs`、`route-binding.test.mjs`；所有 10 个 RPC 携带 `profileRoute`；Rust 使用真实 SQLite 编辑配置，证明旧路由不启动工作；浏览器同 SSH 内切用户后禁止保存 |
| 7 导航 | 固定终端/文件入口；重复激活幂等；恢复辅助面板标签、宽度、开关和文件区焦点；弹窗焦点及未保存内容受到保护 | 原有 20 终端浏览器回归通过；新浏览器测试包含会话/模式恢复、弹窗 Tab/Escape、取消后焦点恢复 |
| 8 恢复流程 | 未连接可选择已开会话、连接配置或新建连接；识别失败可重试/手填；连接中可取消；目录失败可独立重试；路由变更可按新配置打开 | 浏览器空态、自然超时、发送失败、连接取消、手动目标及目录重试验证；刷新只发列目录请求 |
| 9 全程时限 | 前端识别 12 秒、单候选 20 秒、总流程 60 秒；后端统一覆盖配置读取、连接及操作。原生连接关闭 socket，Windows CLI 清理进程树；旧结果不能发布 | Rust 截止时间、提前取消、配置/DNS 等待、握手、缓存 I/O、异常与清理测试；7 项真实回环 SFTP 协议验证 |
| 10 浏览效率 | 合并面包屑与路径输入；紧凑/舒适密度、隐藏文件开关、筛选、排序、多选及批量传输；名称、大小、时间按列对齐 | 浏览器键盘、多选、筛选/空态、密度及批量任务验证；测量列边界和大小文本右边缘一致 |
| 11 缓存与结果 | 保留缓存，过期后后台更新，显示更新时间；强制刷新优先于旧请求；结果打开原会话/原目录，原会话已关闭时重建文件会话 | 目录竞态与缓存测试；浏览器返回过期目录不丢选择/滚动、原任务定位、关闭原终端后定位及路由绑定验证 |
| 12 键盘/布局 | 方向键、Enter、Space、Ctrl+A、Alt+上、Ctrl+L；可聚焦文件行和带标签路径；双栏比例 35–65%，鼠标和键盘可调；两主题保留可用编辑区 | 浏览器 1280×820 / 980×640 四组合，边界、文字对齐、对比度、分隔条和编辑器高度检查 |

## 当前验证结果

| 检查 | 结果 |
|---|---|
| `npm run build` | 通过，包含 TypeScript 和 Vue 模板编译 |
| `npm run test:transfer` | 81 通过，0 失败、0 跳过；包括实际 Git Bash 二进制/含引号路径往返及失败后目标文件保护 |
| `npm run test:ui` | 通过；旧单面板、切换取消任务等源码契约已更新为当前模块接入，竞态由行为测试验证 |
| `npm run test:architecture` | 4 通过 |
| `npm run test:routing` | 17 通过 |
| `npm run test:scripts` | 298 通过 |
| `npm run test:workspace-browser` | 20 个终端的鼠标、键盘、视图、辅助面板、同步及关闭回归通过 |
| `npm run test:sftp-browser` | 21 项端到端场景通过，真实 Vue 组件和终端提示符逻辑，模拟 Tauri IPC；没有未捕获异常 |
| `cargo test` | 234 通过，0 失败；7 项需要外部本机 fixture 的协议测试默认忽略 |
| 单独运行 SFTP 协议测试 | 7 通过，0 失败、0 跳过 |
| 改动的 Rust 文件 `rustfmt --check` / `git diff --check` | 通过 |
| impeccable 静态检测 | 新文件组件和样式 0 命中；视觉结论同时依据浏览器截图与测量 |

每侧文件列表在 1280×820 为约 512 px 高，在 980×640 为约 332 px 高，紧凑行高 32 px；两尺寸均保持左右双栏，没有文档横向溢出。名称/大小/时间列边界一致，大小文本实际右对齐。抽查元数据、页脚和输入提示的最小对比度为暗色 7.96:1、亮色 5.59:1。身份失效警告约 37 px，高度 760 px 的编辑弹窗仍保留约 581 px 的文本编辑区。

## 实现入口

- 会话与界面：[AppShell.vue](../frontend/src/app/ui/AppShell.vue)、[FileTransferPanel.vue](../frontend/src/domains/transfer/presentation/components/FileTransferPanel.vue)、[文件组件](../frontend/src/domains/transfer/presentation/components/)。
- 连接、目录、偏好和任务：[transfer/application](../frontend/src/domains/transfer/application/)。已删除不再使用的旧 `useTransferTasks`。
- 后端截止与任务注册：[sftp_task.rs](../src-tauri/src/app/sftp_task.rs)、[tasks.rs](../src-tauri/src/app/tasks.rs)。
- 原生/CLI 取消和路由保护：[sftp.rs](../src-tauri/src/domain/connection/sftp.rs)、[sftp_process.rs](../src-tauri/src/domain/connection/sftp_process.rs)、[ssh_cancel.rs](../src-tauri/src/domain/terminal/ssh_cancel.rs)。
- 可复跑的验证：[前端行为测试](../frontend/tests/transfer/)、[SFTP 浏览器测试](../frontend/tests/browser/sftp-workspace.browser.mjs)、[本机协议测试](../src-tauri/src/domain/connection/sftp_protocol_tests.rs)、[SFTP fixture](../src-tauri/tests/fixtures/sftp_server.py)。

## 运行证据与复验

本地验收产物保存在忽略提交的 `outputs/`：

- [浏览器报告](../outputs/sftp-remediation-2026-09-15/browser-report.json)、[前端测试](../outputs/sftp-remediation-2026-09-15/frontend-transfer-tests.txt)、[构建日志](../outputs/sftp-remediation-2026-09-15/frontend-build.txt)。
- [夜间界面](../outputs/sftp-remediation-2026-09-15/sftp-dark-1280x820.png)、[亮色界面](../outputs/sftp-remediation-2026-09-15/sftp-light-1280x820.png)、[小窗口](../outputs/sftp-remediation-2026-09-15/sftp-dark-980x640.png)、[草稿保护](../outputs/sftp-remediation-2026-09-15/sftp-editor-stale-draft.png)。
- [Rust 测试日志](../outputs/sftp-rust-suite-verification.txt)、[SFTP 协议日志](../outputs/sftp-protocol-verification.txt)。

前端命令在 `frontend/` 运行。浏览器脚本需要本地 Vite `127.0.0.1:4183` 和使用独立临时用户目录的 Edge/Chromium CDP `127.0.0.1:9233`；可通过 `AI_TERM_SFTP_APP_URL`、`AI_TERM_SFTP_CDP_URL` 修改。脚本创建自己的测试页和模拟 IPC，不应指向原生应用或生产连接。

Rust 命令在 `src-tauri/` 运行。协议测试需要隔离 Python 环境安装 `paramiko`，将 `AI_TERM_SFTP_FIXTURE_PYTHON` 指向该环境的 Python，再执行：

```text
cargo test --lib protocol_tests -- --ignored --test-threads=1
```

协议测试实际执行原生 libssh2 和 Windows `sftp.exe` 的读写、版本冲突、缓存复用、取消与超时，并验证 `cd` 失败后不会继续上传、写入失败不会换路重放。它们只使用回环地址、临时根目录及隔离的凭据/known_hosts，未连接真实业务堡垒机。

截止时间到达即取消任务；后端最多额外等待 750 ms 清理工作线程再回复，前端总流程仍按自身绝对截止时间结束。系统 DNS 或配置读取可能独立完成，但取消后的结果不会启动后续 SFTP 操作，也不会覆盖新连接或执行迟到写入。
