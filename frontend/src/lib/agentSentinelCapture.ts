import { truncateCaptureOutput } from './shellIntegration'

// 无 OSC 133 语义标记的终端(远端 SSH 是主要场景)上的命令捕获兜底。
// 设计见 docs/ai-agent-mode-development.md 10.3。
//
// 派发的命令被包装成:
//   printf '\n__AI_TERM_%s__\n' <nonce>B; <原命令>; printf '\n__AI_TERM_%s__:%d\n' <nonce>E $?
// 关键性质:nonce 作为 %s 参数传入而非写死在格式串里,因此组装后的标记
// (__AI_TERM_<nonce>B__)只可能出现在 printf 真正执行后的输出中。shell 对命令行的
// 回显、history、ps 撞见我们自己这条进程,看到的都是含 %s 的字面文本,永远匹配不上——
// 哨兵方案最主要的失败模式(回显串扰)由此消失,不需要"跳过第一次出现"之类的启发式。
// 结束标记额外要求冒号后是数字,字面的 %d 同样匹配不上,构成第二道保险。

const MARKER_PREFIX = '__AI_TERM_'
/** 探针命令的预期退出码:同时验证 printf 可用、$? 语义正确、标记能原样往返。 */
export const SENTINEL_PROBE_EXIT_CODE = 7
/** 跨 chunk 匹配的回溯长度:标记可能被切在两个数据块之间。 */
const MARKER_CARRY_CHARS = 96
/** 收集缓冲的硬上限倍数;超过后丢弃头部并降级标注(对齐 OSC 路径的 marker 失效兜底)。 */
const COLLECT_LIMIT_FACTOR = 8

/**
 * ANSI 转义序列:CSI(\x1b[...)、OSC(\x1b]... 以 BEL 或 ST 收尾)与双字符转义。
 * OSC 路径读的是 xterm 渲染后的缓冲(天然无转义),这里剥离以保持两条路径的输出一致。
 */
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g

export interface SentinelCaptureResult {
  output: string
  exitCode?: number
  truncated: boolean
}

export interface SentinelScannerOptions {
  nonce: string
  maxOutputChars: number
  onFinished: (result: SentinelCaptureResult) => void
}

export interface SentinelScanner {
  /** 喂入一块原始终端输出。 */
  push(chunk: string): void
  /** 当前已收集的输出(截断规则同最终结果),用于超时时上报部分输出。 */
  peekOutput(): string
  /** 解除;不再回调。 */
  dispose(): void
}

export function createSentinelNonce(random: () => number = Math.random): string {
  const value = Math.floor(random() * 0xffffffff) >>> 0
  return value.toString(16).padStart(8, '0')
}

export function sentinelBeginMarker(nonce: string): string {
  return `${MARKER_PREFIX}${nonce}B__`
}

export function sentinelEndMarkerPattern(nonce: string): RegExp {
  return new RegExp(`${MARKER_PREFIX}${nonce}E__:(-?\\d+)`)
}

/**
 * 包装命令。结尾多余的 `;` 会被剥掉,否则 `cmd;; printf` 是语法错误。
 * 调用方需先用 isSuffixSafeForSentinel 确认命令可安全追加。
 */
export function wrapCommandWithSentinel(command: string, nonce: string): string {
  const value = command.trim().replace(/;+$/, '').trim()
  const begin = `printf '\\n${MARKER_PREFIX}%s__\\n' ${nonce}B`
  const end = `printf '\\n${MARKER_PREFIX}%s__:%d\\n' ${nonce}E $?`
  return `${begin}; ${value}; ${end}`
}

/** 能力探针:`(exit 7)` 是 POSIX 子 shell,无输出、无副作用。 */
export function buildSentinelProbeCommand(nonce: string): string {
  return wrapCommandWithSentinel(`(exit ${SENTINEL_PROBE_EXIT_CODE})`, nonce)
}

/** 剥离 ANSI 转义并把 CRLF 归一为 LF;裸 \r 留待收集时按"回到行首"处理。 */
function normalizeChunk(chunk: string): string {
  return chunk.replace(ANSI_RE, '').replace(/\r\n/g, '\n')
}

export function createSentinelScanner(options: SentinelScannerOptions): SentinelScanner {
  const { nonce, maxOutputChars, onFinished } = options
  const beginMarker = sentinelBeginMarker(nonce)
  const endPattern = sentinelEndMarkerPattern(nonce)
  const collectLimit = Math.max(maxOutputChars, 1) * COLLECT_LIMIT_FACTOR

  let phase: 'waiting-begin' | 'collecting' | 'done' = 'waiting-begin'
  /** waiting-begin 阶段的待匹配文本;进入 collecting 后不再使用。 */
  let pending = ''
  let collected = ''
  let droppedHead = false

  /**
   * 追加时处理裸 \r:终端语义是回到行首,后续内容覆盖当前行(进度条)。
   * 按整行重置近似,避免把 curl/docker pull 的每一帧都塞进模型上下文。
   */
  const appendCollected = (text: string) => {
    const parts = text.split('\r')
    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) {
        const lastNewline = collected.lastIndexOf('\n')
        collected = lastNewline < 0 ? '' : collected.slice(0, lastNewline + 1)
      }
      collected += parts[index]
    }
    if (collected.length > collectLimit * 2) {
      collected = collected.slice(collected.length - collectLimit)
      droppedHead = true
    }
  }

  const buildOutput = (raw: string): { output: string; truncated: boolean } => {
    // printf 的前导 \n 让标记独占一行:收集区间头尾各有一个换行需要剥掉
    const body = raw.replace(/^\n/, '').trimEnd()
    const collapsed = truncateCaptureOutput(body, maxOutputChars)
    if (!droppedHead) return collapsed
    return {
      output: collapsed.output ? `[输出过长,起始位置已超出缓冲,仅保留末尾]\n${collapsed.output}` : '',
      truncated: true
    }
  }

  return {
    push(chunk: string) {
      if (phase === 'done' || !chunk) return
      const text = normalizeChunk(chunk)
      if (!text) return

      if (phase === 'waiting-begin') {
        pending += text
        const index = pending.indexOf(beginMarker)
        if (index < 0) {
          // 只保留尾部,避免长时间等待时无限增长;长度足够容纳被切断的标记
          if (pending.length > beginMarker.length + MARKER_CARRY_CHARS) {
            pending = pending.slice(pending.length - (beginMarker.length + MARKER_CARRY_CHARS))
          }
          return
        }
        phase = 'collecting'
        const rest = pending.slice(index + beginMarker.length)
        pending = ''
        appendCollected(rest)
      } else {
        appendCollected(text)
      }

      // 结束标记必然落在新追加的内容里,只搜尾部窗口即可
      const windowSize = text.length + MARKER_CARRY_CHARS
      const start = Math.max(0, collected.length - windowSize)
      const match = endPattern.exec(collected.slice(start))
      if (!match) return

      phase = 'done'
      const raw = collected.slice(0, start + match.index)
      const built = buildOutput(raw)
      onFinished({
        output: built.output,
        exitCode: Number.parseInt(match[1], 10),
        truncated: built.truncated
      })
    },
    peekOutput() {
      if (phase !== 'collecting') return ''
      return buildOutput(collected).output
    },
    dispose() {
      phase = 'done'
      pending = ''
      collected = ''
    }
  }
}
