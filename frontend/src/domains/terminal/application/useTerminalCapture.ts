import { onBeforeUnmount } from 'vue'
import type { AttachedShellIntegration } from '../domain/shellIntegration'
import type { AgentCaptureMode, AgentCommandHandle, AgentCommandResult } from '../../ai/types'
import type { TerminalPaneHandle } from '../domain/terminal'
import { createSentinelNonce, createSentinelScanner, wrapCommandWithSentinel, SENTINEL_PROBE_COMMAND, SENTINEL_PROBE_EXIT_CODE } from '../domain/agentSentinelCapture'
import type { SentinelScanner } from '../domain/agentSentinelCapture'
import { isSuffixSafeForSentinel } from '../../ai/index'
import { createDeferredAgentCommand } from '../domain/deferredAgentCommand'
import { formatError } from '../../../shared/platform/errors'
import type { CommandIntent, TerminalProbe } from '../../../shared/security/commandPolicy'
import { createShellCaptureVerification } from '../domain/shellCaptureVerification'

interface TerminalCaptureOptions {
  getSessionId: () => string
  getShellIntegration: () => AttachedShellIntegration | undefined
  commandExecutionReadiness: TerminalPaneHandle['commandExecutionReadiness']
  executeCommand: (command: string, options?: { historyCommand?: string; internal?: boolean; onWriteFailed?: (error: unknown) => void; allowDuringAgentTakeover?: boolean }) => boolean
  dispatchIntent?: (intent: CommandIntent, onWriteFailed: (error: unknown) => void) => boolean
  prepareProbe?: (probe: TerminalProbe) => Promise<CommandIntent>
  cancelIntent?: (intent: CommandIntent) => Promise<unknown>
  enableShellIntegration?: () => boolean
  bracketedPasteEnabled?: () => boolean
}

export function useTerminalCapture({ getSessionId, getShellIntegration, commandExecutionReadiness, executeCommand, dispatchIntent, prepareProbe, cancelIntent, enableShellIntegration, bracketedPasteEnabled }: TerminalCaptureOptions) {
  let disposed = false
  let activeAgentCaptureAbort: ((reason: string) => void) | undefined

  /** 哨兵扫描器的数据出口;仅在布防期间非空,由 attachTerminalEvents 的回调喂入。 */
  let sentinelSink: ((chunk: string) => void) | undefined

  /** 按会话缓存的哨兵探针结论;会话变更(重连)即失效。 */
  let sentinelProbe: { sessionId: string; epoch: number; mode: AgentCaptureMode } | undefined

  let sentinelProbeInFlight: Promise<AgentCaptureMode> | undefined
  let captureEpoch = 0
  let verification: ReturnType<typeof createShellCaptureVerification> | undefined
  let bracketedProbe: { sessionId: string; epoch: number; supported: boolean } | undefined
  let bracketedProbeInFlight: Promise<boolean> | undefined

  function invalidateCaptureCapability() {
    captureEpoch++
    sentinelProbe = undefined
    bracketedProbe = undefined
    verification = undefined
  }

  const AGENT_CAPTURE_DEFAULT_MAX_CHARS = 4000

  const SENTINEL_PROBE_TIMEOUT_MS = 8_000

  /**
   * 当前终端的命令捕获方式(同步)。未探测的无标记终端乐观返回 sentinel,
   * 真正的结论由 ensureAgentCapture 的探针给出。
   */
  function agentCaptureMode(): AgentCaptureMode {
    if (sentinelProbe?.sessionId === getSessionId() && sentinelProbe.epoch === captureEpoch) return sentinelProbe.mode
    return 'sentinel'
  }

  /** 哨兵探针是否已对当前会话给出结论。 */
  function agentCaptureProbed() {
    return sentinelProbe?.sessionId === getSessionId() && sentinelProbe.epoch === captureEpoch
  }

  function agentCapturePreparing() {
    return sentinelProbeInFlight !== undefined || bracketedProbeInFlight !== undefined
  }

  /** Negotiate a whole multiline readline/ZLE input, only while DECSET 2004
   * is live. Marker support by itself never opts a command into raw paste. */
  async function ensureBracketedCapture(): Promise<boolean> {
    if (!prepareProbe || !bracketedPasteEnabled?.() || agentCaptureMode() !== 'markers' || agentReadinessFailure()) return false
    if (bracketedProbe?.sessionId === getSessionId() && bracketedProbe.epoch === captureEpoch) return bracketedProbe.supported
    if (bracketedProbeInFlight) return bracketedProbeInFlight
    const sessionId = getSessionId(), epoch = captureEpoch
    const current = () => !disposed && getSessionId() === sessionId && captureEpoch === epoch
    const pending = (async () => {
      const handle = runProbe({ kind: 'bracketed-capture' }, 256, () => current() && bracketedPasteEnabled?.() ? '' : '括号粘贴能力或目标已变化')
      const timer = window.setTimeout(() => handle.cancel(), SENTINEL_PROBE_TIMEOUT_MS)
      try {
        const outcome = await handle.result
        if (!current() || outcome.status !== 'completed' || outcome.exitCode !== 7) return false
        const deadline = Date.now() + 2500
        while (current() && Date.now() < deadline && (!verification?.verified() || commandExecutionReadiness() !== 'ready' || !bracketedPasteEnabled?.())) await new Promise(resolve => window.setTimeout(resolve, 25))
        const supported = current() && bracketedPasteEnabled?.() === true && verification?.verified() === true && outcome.status === 'completed' && outcome.exitCode === 7
        if (current()) bracketedProbe = { sessionId, epoch, supported }
        return supported
      } finally { window.clearTimeout(timer) }
    })()
    bracketedProbeInFlight = pending
    try { return await pending } finally { if (bracketedProbeInFlight === pending) bracketedProbeInFlight = undefined; verification = undefined }
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
  function captureWithMarkers(command: string, maxOutputChars: number, intent?: CommandIntent): AgentCommandHandle {
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
      // A text mismatch means the result cannot be associated with this
      // dispatch. Screen reconstruction or shell reporting can also cause it;
      // this is not evidence of manual input. Empty text remains unknown.
      const captured = normalizeForCommandMatch(capture.command)
      const mismatch = captured !== '' && captured !== normalizeForCommandMatch(command)
      const completionUnconfirmed = capture.completionUnconfirmed || capture.exitCode === undefined
      if (mismatch || completionUnconfirmed) invalidateCaptureCapability()
      resolveResult({
        status: 'completed',
        output: capture.output,
        exitCode: capture.exitCode,
        durationMs: Math.max(0, capture.finishedAt - capture.startedAt),
        truncated: capture.truncated,
        completionUnconfirmed: completionUnconfirmed || undefined,
        commandMismatch: mismatch || undefined
      })
    }, command)

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

    if (!(intent && dispatchIntent ? dispatchIntent(intent, failWrite) : executeCommand(command, { onWriteFailed: failWrite, allowDuringAgentTakeover: true }))) {
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
        invalidateCaptureCapability()
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
    options?: { skipHistory?: boolean; intent?: CommandIntent }
  ): AgentCommandHandle {
    const safety = isSuffixSafeForSentinel(command)
    if (!options?.intent && !safety.ok) {
      return agentDispatchFailure(`${safety.reason};该终端无 shell integration 标记,需改写为可追加哨兵的单条命令`)
    }
    if (activeAgentCaptureAbort) return agentDispatchFailure('已有 Agent 命令正在等待终端结果')

    const nonce = options?.intent?.capture.nonce ?? createSentinelNonce()
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
    if (!(options?.intent && dispatchIntent ? dispatchIntent(options.intent, failWrite) : executeCommand(wrapped, {
      historyCommand: options?.skipHistory ? '' : command,
      internal: options?.skipHistory === true,
      onWriteFailed: failWrite,
      allowDuringAgentTakeover: true
    }))) {
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
    if (agentCaptureProbed()) return agentCaptureMode()
    if (sentinelProbeInFlight) return sentinelProbeInFlight
    if (agentReadinessFailure()) return 'sentinel'

    const probedSessionId = getSessionId()
    const epoch = captureEpoch
    const current = () => !disposed && probedSessionId === getSessionId() && epoch === captureEpoch
    const waitForPrompt = async (verifyMarkers: boolean) => {
      const deadline = Date.now() + 2500
      while (current() && Date.now() < deadline && (commandExecutionReadiness() === 'shell-busy'
        || (verifyMarkers && verification?.started() && !verification.verified()))) {
        await new Promise(resolve => window.setTimeout(resolve, 25))
      }
      return current() && commandExecutionReadiness() === 'ready'
    }
    const run = async (kind: 'capture' | 'shell-integration') => {
      const probe = prepareProbe ? runProbe({ kind }, 256, () => current() ? '' : '探测目标已经变化') : captureWithSentinel(SENTINEL_PROBE_COMMAND, 256, { skipHistory: true })
      const timer = window.setTimeout(() => probe.cancel(), SENTINEL_PROBE_TIMEOUT_MS)
      try {
        const outcome = await probe.result
        const ready = await waitForPrompt(kind === 'capture')
        return { outcome, ready }
      } finally {
        window.clearTimeout(timer)
      }
    }
    const pending = (async (): Promise<AgentCaptureMode> => {
      let result = await run('capture')
      if (!current()) return 'sentinel'
      if (result.outcome.status !== 'completed' || result.outcome.exitCode !== SENTINEL_PROBE_EXIT_CODE) return 'unsupported'
      if (verification?.verified()) return 'markers'
      // Existing integrations get first use. The fixed loader is idempotent,
      // limited to supported shells and never writes remote startup files.
      if (prepareProbe && enableShellIntegration?.() && result.ready) {
        const installed = await run('shell-integration')
        if (!current() || !installed.ready || installed.outcome.status !== 'completed') return 'sentinel'
        result = await run('capture')
        if (!current()) return 'sentinel'
        if (result.outcome.status !== 'completed' || result.outcome.exitCode !== SENTINEL_PROBE_EXIT_CODE) return 'unsupported'
        if (verification?.verified()) return 'markers'
      }
      return 'sentinel'
    })()
    sentinelProbeInFlight = pending
    try {
      const mode = await pending
      if (current()) sentinelProbe = { sessionId: probedSessionId, epoch, mode }
      return current() ? mode : agentCaptureMode()
    } finally {
      if (sentinelProbeInFlight === pending) sentinelProbeInFlight = undefined
      verification = undefined
    }
  }

  /**
   * Agent 派发命令并捕获输出与退出码(文档 6.2 / 10.3)。
   * 超时决策在循环层;cancel 只放弃等待,不终止命令本身。
   */
  function runCommandAndCapture(
    command: string,
    options?: { maxOutputChars?: number; dispatchGuard?: () => string; internal?: boolean; intent?: CommandIntent; probe?: TerminalProbe }
  ): AgentCommandHandle {
    if (options?.probe && prepareProbe) return runProbe(options.probe, options.maxOutputChars ?? AGENT_CAPTURE_DEFAULT_MAX_CHARS, options.dispatchGuard)
    const value = command.trim()
    if (!value) return agentDispatchFailure('命令为空')
    const bindingFailure = options?.dispatchGuard?.() ?? ''
    if (bindingFailure) return agentDispatchFailure(bindingFailure)
    const readinessFailure = agentReadinessFailure()
    if (readinessFailure) return agentDispatchFailure(readinessFailure)

    const maxOutputChars = options?.maxOutputChars ?? AGENT_CAPTURE_DEFAULT_MAX_CHARS
    if (dispatchIntent) {
      const intent = options?.intent
      if (!intent || intent.source !== command || (intent.capture.internal && (!options?.internal || intent.capture.kind !== 'sentinel'))) return agentDispatchFailure('缺少与完整命令对应的后端执行记录')
      if (intent.capture.kind === 'bracketed' && !bracketedPasteEnabled?.()) return agentDispatchFailure('终端括号粘贴模式已关闭，请重新准备命令')
      if (intent.capture.kind === 'markers' || intent.capture.kind === 'bracketed') return captureWithMarkers(value, maxOutputChars, intent)
      if (intent.capture.kind === 'sentinel') return captureWithSentinel(value, maxOutputChars, { intent })
      return agentDispatchFailure('执行记录未绑定输出捕获方式')
    }
    const mode = agentCaptureMode()
    // Internal output is removed before xterm rendering; capture its raw sentinel stream.
    if (mode === 'markers') return options?.internal
      ? captureWithSentinel(value, maxOutputChars, { skipHistory: true })
      : captureWithMarkers(value, maxOutputChars)
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
    return captureWithSentinel(value, maxOutputChars, { skipHistory: options?.internal })
  }

  function runProbe(probe: TerminalProbe, maxOutputChars: number, guard?: () => string): AgentCommandHandle {
    let prepared: CommandIntent | undefined
    let started = false
    const handle = createDeferredAgentCommand(async () => {
      const failure = guard?.() || agentReadinessFailure()
      if (failure) return failure
      prepared = await prepareProbe!(probe)
      return guard?.() || agentReadinessFailure()
    }, () => {
      started = true
      if (probe.kind === 'capture' || probe.kind === 'bracketed-capture') verification = createShellCaptureVerification(prepared!.capture.nonce, probe.kind === 'bracketed-capture')
      return captureWithSentinel(prepared!.source, maxOutputChars, { intent: prepared, skipHistory: true })
    })
    void handle.result.finally(() => { if (prepared && !started) void cancelIntent?.(prepared).catch(() => {}) })
    return handle
  }

  function ingestCaptureOutput(data: string) {
    verification?.push(data)
    sentinelSink?.(data)
  }

  function abortActiveCapture(reason: string) {
    invalidateCaptureCapability()
    activeAgentCaptureAbort?.(reason)
  }

  onBeforeUnmount(() => {
    disposed = true
    abortActiveCapture('终端会话已关闭或重新连接')
  })

  return { agentCaptureMode, agentCapturePreparing, agentCaptureSupported, ensureAgentCapture, ensureBracketedCapture, runCommandAndCapture, ingestCaptureOutput, abortActiveCapture, invalidateCaptureCapability }
}
