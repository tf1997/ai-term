import { onBeforeUnmount } from 'vue'
import type { AttachedShellIntegration } from '../domain/shellIntegration'
import type { AgentCaptureMode, AgentCommandHandle, AgentCommandResult } from '../../ai/types'
import type { TerminalPaneHandle } from '../domain/terminal'
import { createSentinelNonce, createSentinelScanner, wrapCommandWithSentinel, SENTINEL_PROBE_COMMAND, SENTINEL_PROBE_EXIT_CODE } from '../domain/agentSentinelCapture'
import type { SentinelScanner } from '../domain/agentSentinelCapture'
import { isSuffixSafeForSentinel } from '../../ai/index'
import { createDeferredAgentCommand } from '../domain/deferredAgentCommand'
import { formatError } from '../../../shared/platform/errors'

interface TerminalCaptureOptions {
  getSessionId: () => string
  getShellIntegration: () => AttachedShellIntegration | undefined
  commandExecutionReadiness: TerminalPaneHandle['commandExecutionReadiness']
  executeCommand: (command: string, options?: { historyCommand?: string; onWriteFailed?: (error: unknown) => void; allowDuringAgentTakeover?: boolean }) => boolean
}

export function useTerminalCapture({ getSessionId, getShellIntegration, commandExecutionReadiness, executeCommand }: TerminalCaptureOptions) {
  let disposed = false
  let activeAgentCaptureAbort: ((reason: string) => void) | undefined

  /** 哨兵扫描器的数据出口;仅在布防期间非空,由 attachTerminalEvents 的回调喂入。 */
  let sentinelSink: ((chunk: string) => void) | undefined

  /** 按会话缓存的哨兵探针结论;会话变更(重连)即失效。 */
  let sentinelProbe: { sessionId: string; supported: boolean } | undefined

  let sentinelProbeInFlight: Promise<boolean> | undefined

  const AGENT_CAPTURE_DEFAULT_MAX_CHARS = 4000

  const SENTINEL_PROBE_TIMEOUT_MS = 8_000

  /**
   * 当前终端的命令捕获方式(同步)。未探测的无标记终端乐观返回 sentinel,
   * 真正的结论由 ensureAgentCapture 的探针给出。
   */
  function agentCaptureMode(): AgentCaptureMode {
    if (getShellIntegration()?.tracker.sawMarkers) return 'markers'
    if (sentinelProbe?.sessionId === getSessionId() && !sentinelProbe.supported) return 'unsupported'
    return 'sentinel'
  }

  /** 哨兵探针是否已对当前会话给出结论。 */
  function agentCaptureProbed() {
    return agentCaptureMode() === 'markers' || sentinelProbe?.sessionId === getSessionId()
  }

  function agentCapturePreparing() {
    return sentinelProbeInFlight !== undefined
  }

  /** Agent 模式可用性:有语义标记,或哨兵兜底未被探针否定。 */
  function agentCaptureSupported() {
    return agentCaptureMode() !== 'unsupported'
  }

  function normalizeForCommandMatch(command: string) {
    return command.replace(/\s+/g, ' ').trim()
  }

  function agentDispatchFailure(reason: string): AgentCommandHandle {
    const result: AgentCommandResult = {
      status: 'dispatch-failed',
      output: '',
      durationMs: 0,
      truncated: false,
      failureReason: reason
    }
    return { result: Promise.resolve(result), peekOutput: () => '', cancel: () => {} }
  }

  function agentReadinessFailure(): string {
    if (disposed) return '终端不可用或连接已断开'
    const readiness = commandExecutionReadiness()
    if (readiness === 'ready') return ''
    const reasonMap: Record<string, string> = {
      'line-busy': '当前命令行已有输入或补全内容',
      'shell-busy': 'Shell 尚未返回可执行提示符',
      unavailable: '终端不可用或连接已断开'
    }
    return reasonMap[readiness] ?? `终端未就绪(${readiness})`
  }

  /** OSC 133 路径:布防 tracker,由语义标记划定输出区间(文档 6.2)。 */
  function captureWithMarkers(command: string, maxOutputChars: number): AgentCommandHandle {
    const tracker = getShellIntegration()?.tracker
    if (!tracker) return agentDispatchFailure('终端未启用 shell integration')
    if (activeAgentCaptureAbort) return agentDispatchFailure('已有 Agent 命令正在等待终端结果')
    const dispatchedAt = Date.now()
    let settled = false
    let abortCapture!: (reason: string) => void
    let resolveResult!: (result: AgentCommandResult) => void
    const result = new Promise<AgentCommandResult>((resolve) => {
      resolveResult = resolve
    })
    const clearActiveCapture = () => {
      if (activeAgentCaptureAbort === abortCapture) activeAgentCaptureAbort = undefined
    }
    const armed = tracker.armCommandCapture(maxOutputChars, (capture) => {
      if (settled) return
      settled = true
      clearActiveCapture()
      // 捕获到的命令与派发不一致 = 用户手动输入串扰;空文本视为未知,不判串扰
      const captured = normalizeForCommandMatch(capture.command)
      const mismatch = captured !== '' && captured !== normalizeForCommandMatch(command)
      resolveResult({
        status: 'completed',
        output: capture.output,
        exitCode: capture.exitCode,
        durationMs: Math.max(0, capture.finishedAt - capture.startedAt),
        truncated: capture.truncated,
        commandMismatch: mismatch || undefined
      })
    })

    abortCapture = (reason: string) => {
      if (settled) return
      settled = true
      armed.dispose()
      clearActiveCapture()
      resolveResult({
        status: 'dispatch-failed',
        output: '',
        durationMs: Date.now() - dispatchedAt,
        truncated: false,
        failureReason: reason
      })
    }
    activeAgentCaptureAbort = abortCapture
    const failWrite = (error: unknown) => abortCapture(`命令写入终端失败:${formatError(error)}`)

    if (!executeCommand(command, { onWriteFailed: failWrite, allowDuringAgentTakeover: true })) {
      armed.dispose()
      settled = true
      clearActiveCapture()
      return agentDispatchFailure('命令未能写入终端(就绪状态在派发瞬间发生变化)')
    }

    return {
      result,
      peekOutput: () => (settled ? '' : armed.peekOutput()),
      cancel: () => {
        if (settled) return
        settled = true
        const partial = armed.peekOutput()
        armed.dispose()
        clearActiveCapture()
        resolveResult({
          status: 'cancelled',
          output: partial,
          durationMs: Date.now() - dispatchedAt,
          truncated: false
        })
      }
    }
  }

  /**
   * 哨兵路径(文档 10.3):把命令包成 printf 标记对,扫描输出流恢复区间与退出码。
   * 结束标记只可能由我们派发的那一行产生,因此不需要 OSC 路径的串扰校验。
   */
  function captureWithSentinel(
    command: string,
    maxOutputChars: number,
    options?: { skipHistory?: boolean }
  ): AgentCommandHandle {
    const safety = isSuffixSafeForSentinel(command)
    if (!safety.ok) {
      return agentDispatchFailure(`${safety.reason};该终端无 shell integration 标记,需改写为可追加哨兵的单条命令`)
    }
    if (activeAgentCaptureAbort) return agentDispatchFailure('已有 Agent 命令正在等待终端结果')

    const nonce = createSentinelNonce()
    const wrapped = wrapCommandWithSentinel(command, nonce)
    const dispatchedAt = Date.now()
    let settled = false
    let abortCapture!: (reason: string) => void
    let scanner: SentinelScanner | undefined
    let resolveResult!: (result: AgentCommandResult) => void
    const result = new Promise<AgentCommandResult>((resolve) => {
      resolveResult = resolve
    })
    const clearActiveCapture = () => {
      if (activeAgentCaptureAbort === abortCapture) activeAgentCaptureAbort = undefined
    }

    const detach = () => {
      if (sentinelSink === feed) sentinelSink = undefined
      scanner?.dispose()
      scanner = undefined
    }

    scanner = createSentinelScanner({
      nonce,
      maxOutputChars,
      onFinished: (capture) => {
        if (settled) return
        settled = true
        detach()
        clearActiveCapture()
        resolveResult({
          status: 'completed',
          output: capture.output,
          exitCode: capture.exitCode,
          durationMs: Date.now() - dispatchedAt,
          truncated: capture.truncated
        })
      }
    })
    function feed(chunk: string) {
      scanner?.push(chunk)
    }

    abortCapture = (reason: string) => {
      if (settled) return
      settled = true
      detach()
      clearActiveCapture()
      resolveResult({
        status: 'dispatch-failed',
        output: '',
        durationMs: Date.now() - dispatchedAt,
        truncated: false,
        failureReason: reason
      })
    }
    activeAgentCaptureAbort = abortCapture
    const failWrite = (error: unknown) => abortCapture(`命令写入终端失败:${formatError(error)}`)

    sentinelSink = feed
    if (!executeCommand(wrapped, {
      historyCommand: options?.skipHistory ? '' : command,
      onWriteFailed: failWrite,
      allowDuringAgentTakeover: true
    })) {
      settled = true
      detach()
      clearActiveCapture()
      return agentDispatchFailure('命令未能写入终端(就绪状态在派发瞬间发生变化)')
    }

    return {
      result,
      peekOutput: () => (settled ? '' : (scanner?.peekOutput() ?? '')),
      cancel: () => {
        if (settled) return
        settled = true
        const partial = scanner?.peekOutput() ?? ''
        detach()
        clearActiveCapture()
        resolveResult({
          status: 'cancelled',
          output: partial,
          durationMs: Date.now() - dispatchedAt,
          truncated: false
        })
      }
    }
  }

  /**
   * 无标记终端的能力探针:跑一条 `(exit 7)` 的哨兵命令,验证 printf 可用、
   * `$?` 语义正确、标记能原样往返。fish / PowerShell / cmd 会自然失败,
   * 因此不需要猜 shell 方言。结论按会话缓存。
   */
  async function ensureAgentCapture(): Promise<AgentCaptureMode> {
    const mode = agentCaptureMode()
    if (mode === 'markers' || mode === 'unsupported') return mode
    if (sentinelProbe?.sessionId === getSessionId()) return sentinelProbe.supported ? 'sentinel' : 'unsupported'
    if (sentinelProbeInFlight) return (await sentinelProbeInFlight) ? 'sentinel' : 'unsupported'
    if (agentReadinessFailure()) return 'sentinel'

    const probedSessionId = getSessionId()
    // 派发裸载荷:包装与 nonce 由 captureWithSentinel 独占,重复包装会读到 printf 的退出码
    const probe = captureWithSentinel(SENTINEL_PROBE_COMMAND, 256, { skipHistory: true })
    sentinelProbeInFlight = (async () => {
      const timer = window.setTimeout(() => probe.cancel(), SENTINEL_PROBE_TIMEOUT_MS)
      try {
        const outcome = await probe.result
        return outcome.status === 'completed' && outcome.exitCode === SENTINEL_PROBE_EXIT_CODE
      } finally {
        window.clearTimeout(timer)
      }
    })()

    let supported = false
    try {
      supported = await sentinelProbeInFlight
    } finally {
      sentinelProbeInFlight = undefined
    }
    // 探针期间会话被切换/重连时结论作废
    if (probedSessionId !== getSessionId()) return agentCaptureMode()
    sentinelProbe = { sessionId: probedSessionId, supported }
    return supported ? 'sentinel' : 'unsupported'
  }

  /**
   * Agent 派发命令并捕获输出与退出码(文档 6.2 / 10.3)。
   * 超时决策在循环层;cancel 只放弃等待,不终止命令本身。
   */
  function runCommandAndCapture(
    command: string,
    options?: { maxOutputChars?: number; dispatchGuard?: () => string }
  ): AgentCommandHandle {
    const value = command.trim()
    if (!value) return agentDispatchFailure('命令为空')
    const bindingFailure = options?.dispatchGuard?.() ?? ''
    if (bindingFailure) return agentDispatchFailure(bindingFailure)
    const readinessFailure = agentReadinessFailure()
    if (readinessFailure) return agentDispatchFailure(readinessFailure)

    const maxOutputChars = options?.maxOutputChars ?? AGENT_CAPTURE_DEFAULT_MAX_CHARS
    const mode = agentCaptureMode()
    if (mode === 'markers') return captureWithMarkers(value, maxOutputChars)
    if (mode === 'unsupported') {
      return agentDispatchFailure('当前终端既无 shell integration 语义标记,也不支持哨兵捕获,Agent 无法感知命令完成')
    }
    if (!agentCaptureProbed()) {
      // 未探测就派发有误判风险:先探针。停止期间不得在探针完成后补发真实命令。
      return createDeferredAgentCommand(
        async () => {
          const probed = await ensureAgentCapture()
          if (probed === 'unsupported') {
            return '当前终端的 shell 不支持哨兵捕获(需 POSIX printf 与 $?),Agent 暂不可用'
          }
          const delayedBindingFailure = options?.dispatchGuard?.() ?? ''
          if (delayedBindingFailure) return delayedBindingFailure
          return agentReadinessFailure()
        },
        () => runCommandAndCapture(value, options)
      )
    }
    return captureWithSentinel(value, maxOutputChars)
  }

  function ingestCaptureOutput(data: string) {
    sentinelSink?.(data)
  }

  function abortActiveCapture(reason: string) {
    activeAgentCaptureAbort?.(reason)
  }

  onBeforeUnmount(() => {
    disposed = true
    abortActiveCapture('终端会话已关闭或重新连接')
  })

  return { agentCapturePreparing, agentCaptureSupported, ensureAgentCapture, runCommandAndCapture, ingestCaptureOutput, abortActiveCapture }
}
