import { onBeforeUnmount, watch } from 'vue'
import type { FileTargetBinding, TerminalFileBridge } from '../domain/fileSession'
import { captureFileTarget } from '../domain/fileSession'
import type { TerminalOutputDeltaEvent } from '../../terminal/types'
import { boundedOperation } from './useSftpConnection'
import { cleanTerminalText, findStandaloneIdentityMarker } from '../domain/terminalIdentity'
import { remoteParentPath, shellQuote } from '../domain/transferPaths'
import { localWriteTransferFile } from '../infrastructure/api'

export const INLINE_TRANSFER_LIMIT = 700 * 1024

export function useTerminalFileTransfer(options: {
  bridge: () => TerminalFileBridge | undefined
  generation: () => number
  timeoutMs?: number
}, source = { writeFile: localWriteTransferFile }) {
  const pending = new Map<
    string,
    {
      begin: string
      end: string
      output: string
      terminalId: string
      generation: number
      complete: boolean
      resolve: (body: string) => void
      reject: (error: Error) => void
    }
  >()
  const operations = new Map<AbortController, { interruptAllowed: boolean }>()
  let disposed = false
  let sequence = 0
  function feedOutput(event: TerminalOutputDeltaEvent) {
    for (const operation of pending.values()) {
      if (operation.complete || event.terminalId !== operation.terminalId || operation.generation !== options.generation()) continue
      operation.output += event.delta
      if (operation.output.length > INLINE_TRANSFER_LIMIT * 2 + 160_000) {
        operation.reject(new Error('终端文件输出超过限制，请使用 SFTP。'))
        continue
      }
      const text = cleanTerminalText(operation.output)
      const begin = findStandaloneIdentityMarker(text, operation.begin, 0)
      const end =
        begin && findStandaloneIdentityMarker(text, operation.end, begin.index + begin.marker.length)
      if (begin && end) {
        operation.complete = true
        operation.resolve(text.slice(begin.index + begin.marker.length, end.index).trim())
      }
    }
  }
  function identityGuard(target: FileTargetBinding) {
    const identity = target.identity
    if (!identity) throw new Error('请先识别当前终端服务器。')
    return `[ "$(id -un)" = ${shellQuote(identity.username)} ] && [ "$(hostname)" = ${shellQuote(identity.hostname)} ]${identity.machine ? ` && [ "$(cat /etc/machine-id 2>/dev/null)" = ${shellQuote(identity.machine)} ]` : ''}`
  }
  async function run(
    target: FileTargetBinding,
    signal: AbortSignal,
    build: (begin: string, end: string) => string,
  ) {
    if (disposed || signal.aborted) throw new Error('任务已取消')
    if (operations.size) throw new Error('当前终端已有文件传输，请等待完成后重试。')
    const bridge = options.bridge()
    if (!bridge || options.generation() !== target.generation ||
      !['ready', 'shell-busy'].includes(bridge.readiness()))
      throw new Error('终端不在原服务器的空闲提示符，已停止传输。')
    const id = `${Date.now()}_${++sequence}_${Math.random().toString(36).slice(2)}`
    const begin = `AI_TERM_FILE_BEGIN_${id}`,
      end = `AI_TERM_FILE_END_${id}`
    const controller = new AbortController()
    const state = { interruptAllowed: true }
    operations.set(controller, state)
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) controller.abort()
    let dispatched = false, interrupted = false
    function stopCommand() {
      if (!dispatched || interrupted || pending.get(id)?.complete || !state.interruptAllowed ||
        disposed || options.generation() !== target.generation) return
      interrupted = true
      try { void Promise.resolve(bridge!.interrupt?.()).catch(() => {}) } catch {}
    }
    async function waitForPrompt() {
      // A result marker can arrive just before the next shell prompt, especially in a batch.
      const deadline = Date.now() + 1_500
      while (bridge!.readiness() !== 'ready') {
        if (controller.signal.aborted || disposed || options.generation() !== target.generation)
          throw new Error('终端连接已变化或任务已取消。')
        if (bridge!.readiness() !== 'shell-busy' || Date.now() >= deadline)
          throw new Error('终端不在原服务器的空闲提示符，已停止传输。')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    try {
      const body = await boundedOperation(
        async () => {
          await waitForPrompt()
          if (controller.signal.aborted || disposed || options.generation() !== target.generation)
            throw new Error('终端连接已变化或任务已取消。')
          const output = new Promise<string>((resolve, reject) => {
            pending.set(id, {
              begin,
              end,
              output: '',
              terminalId: target.terminalId,
              generation: target.generation,
              complete: false,
              resolve,
              reject,
            })
          })
          const sent = Promise.resolve().then(async () => {
            if (controller.signal.aborted || disposed || options.generation() !== target.generation) {
              throw new Error('终端连接已变化或任务已取消。')
            }
            const command = build(begin, end)
            dispatched = true
            try {
              if (!(await bridge.write(command))) {
                dispatched = false
                throw new Error('终端传输命令发送失败。')
              }
            } catch (reason) { dispatched = false; throw reason }
          })
          return Promise.all([output, sent]).then(([body]) => body)
        },
        options.timeoutMs ?? 60_000,
        controller.signal,
        stopCommand,
      )
      if (options.generation() !== target.generation) throw new Error('终端连接已变化，已忽略原传输结果。')
      if (!/(?:^|\n)status=0\s*$/.test(body))
        throw new Error('终端传输失败：请检查服务器身份、文件路径、权限、base64 支持及文件大小。')
      return body.replace(/(?:^|\n)status=0\s*$/, '').trim()
    } catch (reason) {
      stopCommand()
      throw reason
    } finally {
      controller.abort()
      pending.delete(id)
      operations.delete(controller)
      signal.removeEventListener('abort', abort)
    }
  }
  async function upload(file: File, destination: string, target: FileTargetBinding, signal: AbortSignal) {
    target = captureFileTarget(target)
    if (file.size > INLINE_TRANSFER_LIMIT) throw new Error('终端传输仅支持 700 KB 以内的文件，请使用 SFTP。')
    const bytes = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    const encoded =
      btoa(binary)
        .match(/.{1,76}/g)
        ?.join('\n') ?? ''
    const guard = identityGuard(target)
    await run(target, signal, (begin, end) => {
      const eof = `${end}_DATA`
      return (
        `printf '\\n${begin}\\n'; ( ${guard} || exit 1\n` +
        `ai_term_tmp=$(mktemp ${shellQuote(`${remoteParentPath(destination)}/.ai-term-upload.XXXXXX`)}) || exit 1\n` +
        `trap 'rm -f -- "$ai_term_tmp"' EXIT; trap 'exit 130' HUP INT TERM\n` +
        `base64 -d > "$ai_term_tmp" <<'${eof}'\n${encoded}\n${eof}\n` +
        `if [ "$?" -ne 0 ]; then exit 1; fi\nmv -f -- "$ai_term_tmp" ${shellQuote(destination)}\n); printf '\\nstatus=%s\\n${end}\\n' "$?"\n`
      )
    })
    return { message: '终端上传完成', remotePath: destination, targetPath: destination }
  }
  async function download(
    remotePath: string,
    localPath: string,
    target: FileTargetBinding,
    signal: AbortSignal,
    overwrite = false,
  ) {
    target = captureFileTarget(target)
    const guard = identityGuard(target)
    const encoded = await run(
      target,
      signal,
      (begin, end) =>
        `printf '\\n${begin}\\n'; if ${guard} && [ -f ${shellQuote(remotePath)} ] && [ "$(wc -c < ${shellQuote(remotePath)})" -le ${INLINE_TRANSFER_LIMIT} ]; then if base64 < ${shellQuote(remotePath)}; then printf '\\nstatus=0\\n'; else printf '\\nstatus=1\\n'; fi; else printf '\\nstatus=1\\n'; fi; printf '${end}\\n'\n`,
    )
    if (!/^[A-Za-z0-9+/=\s]*$/.test(encoded)) throw new Error('没有收到有效的文件内容，请重试。')
    const binary = atob(encoded.replace(/\s/g, ''))
    if (binary.length > INLINE_TRANSFER_LIMIT) throw new Error('文件超过终端传输限制。')
    if (signal.aborted || disposed || options.generation() !== target.generation)
      throw new Error('终端连接已变化或任务已取消')
    const data = Array.from(binary, (character) => character.charCodeAt(0))
    await source.writeFile(localPath, data, overwrite)
    return { message: '终端下载完成', localPath, targetPath: localPath }
  }
  function disconnect() {
    for (const [controller, state] of operations) {
      state.interruptAllowed = false
      controller.abort()
    }
    for (const operation of pending.values()) operation.reject(new Error('终端连接已断开，传输已停止。'))
    pending.clear()
  }
  watch(options.generation, disconnect, { flush: 'sync' })
  onBeforeUnmount(() => { disposed = true; disconnect() })
  return { feedOutput, upload, download, disconnect }
}
