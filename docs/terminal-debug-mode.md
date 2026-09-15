# 终端调试模式

在「设置中心 → 应用设置 → 调试模式」切换。默认关闭，设置保存到本机的 `ai-term:user-settings:v1`，重启后恢复。开关作用于下一次内部操作；已发送的操作沿用发送时的设置，已有终端记录不会被清除。

- 关闭时，隐藏应用通过内部输入路径注册的 `AI_TERM_IDENT_*` 身份探测和 `AI_TERM_FILE_*` 终端传输命令的回显、标记及响应正文。
- 开启时，显示这些命令和诊断输出，便于排查身份识别及终端传输问题。
- 普通命令、响应和错误继续显示。过滤器不按 `AI_TERM_` 等关键词全局删除用户输出，只跟踪应用注册的操作。

原始协议流与显示流分离：身份识别、文件传输消费者先收到完整的原始增量；随后过滤结果才进入 xterm 和供 AI 上下文、录制使用的终端快照。隐藏输出不改变协议解析。探测占用空闲 shell 时，PTY 中夹杂的异步输出无法与探测正文区分，也会随该区间隐藏。

身份探测和终端传输的默认过滤期限分别为 12 秒、60 秒，取消或超时会释放过滤。用户恢复输入后，迟到的 BEGIN 不再开启隐藏正文的区间；短暂保留的已知标记行仍可被省略。迟到标记的宽限期最多 2 秒，不因重复响应延长。完整 END 后只执行一次旧提示符定位，迟到响应不会再次上移光标、清除既有输出。标记、CRLF 和 ANSI/OSC 控制序列跨数据块到达时也受同一规则约束。

从仓库根目录运行单元回归和构建：

```powershell
cd frontend
npm ci
npm run test:terminal-debug
npm run build
```

浏览器回归使用真实 Vue AppShell 和 xterm，通过模拟 Tauri IPC 提供命令回显、分块诊断输出及文件数据。它验证设置持久化、终端切换、普通输出、取消和超时等行为，**不连接真实 SSH/SFTP，也不验证原生后端**。需要支持全局 `WebSocket` 的 Node.js（建议 22 或更新版本），以及独立的 Edge/Chrome 调试实例。

先在一个终端中启动 Vite，并保持运行：

```powershell
cd frontend
npm run dev -- --port 4184 --strictPort
```

在另一个 PowerShell 中启动独立浏览器。下面使用 Windows Edge 的常见安装路径，可替换为本机 Edge/Chrome 可执行文件：

```powershell
$debugBrowserExecutable = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
$debugBrowserProfile = Join-Path $env:TEMP ('ai-term-debug-' + [guid]::NewGuid().ToString('N'))
$debugBrowser = Start-Process -FilePath $debugBrowserExecutable -ArgumentList @(
  '--headless=new',
  '--remote-debugging-port=9234',
  "--user-data-dir=`"$debugBrowserProfile`"",
  '--no-first-run',
  'about:blank'
) -WindowStyle Hidden -PassThru
```

浏览器脚本支持以下环境变量：

| 环境变量 | 默认值 |
| --- | --- |
| `AI_TERM_DEBUG_CDP_URL` | `http://127.0.0.1:9234` |
| `AI_TERM_DEBUG_APP_URL` | `http://127.0.0.1:4184` |
| `AI_TERM_DEBUG_OUTPUT` | 仓库内的 `outputs/terminal-debug-2026-09-15`；自定义相对路径按当前工作目录解析 |

在 `frontend` 目录运行，可将报告和截图写入本次续接任务的验证目录：

```powershell
$env:AI_TERM_DEBUG_CDP_URL = 'http://127.0.0.1:9234'
$env:AI_TERM_DEBUG_APP_URL = 'http://127.0.0.1:4184'
$env:AI_TERM_DEBUG_OUTPUT = Join-Path (Resolve-Path ..).Path 'outputs/terminal-debug-resume-2026-09-15'
npm run test:terminal-debug-browser
```

脚本会创建并关闭自己的测试标签页，输出 `browser-report.json` 和截图；Vite 与浏览器进程由运行者在测试结束后关闭。

2026-09-15 的验证材料：[浏览器报告](../outputs/terminal-debug-resume-2026-09-15/browser-report.json)、[浏览器日志](../outputs/terminal-debug-resume-2026-09-15/browser-run.txt)、[回归测试日志](../outputs/terminal-debug-resume-2026-09-15/regression-tests.txt)、[终端传输测试日志](../outputs/terminal-debug-resume-2026-09-15/terminal-transfer-tests.txt)、[构建日志](../outputs/terminal-debug-resume-2026-09-15/build.txt)。
