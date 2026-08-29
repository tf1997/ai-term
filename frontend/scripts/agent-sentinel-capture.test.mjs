import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SENTINEL_PROBE_EXIT_CODE,
  buildSentinelProbeCommand,
  createSentinelNonce,
  createSentinelScanner,
  sentinelBeginMarker,
  wrapCommandWithSentinel
} from '../src/lib/agentSentinelCapture.ts'
import { isSuffixSafeForSentinel } from '../src/lib/agentAutoApprove.ts'

const NONCE = 'a1b2c3d4'

function makeScanner(options = {}) {
  const finished = []
  const scanner = createSentinelScanner({
    nonce: NONCE,
    maxOutputChars: options.maxOutputChars ?? 4000,
    onFinished: (result) => finished.push(result)
  })
  return { scanner, finished }
}

/** 真实终端流:shell 回显命令行,然后才是 printf 的执行结果。 */
function streamFor(command, body, exitCode) {
  const wrapped = wrapCommandWithSentinel(command, NONCE)
  const begin = `\n${sentinelBeginMarker(NONCE)}\n`
  const end = `\n__AI_TERM_${NONCE}E__:${exitCode}\n`
  return `${wrapped}\r\n${begin}${body}${end}`
}

test('包装格式:标记以 %s 参数组装,命令文本里不含组装后的标记', () => {
  const wrapped = wrapCommandWithSentinel('df -h', NONCE)
  assert.equal(
    wrapped,
    `printf '\\n__AI_TERM_%s__\\n' ${NONCE}B; df -h; printf '\\n__AI_TERM_%s__:%d\\n' ${NONCE}E $?`
  )
  // 核心安全性质:回显里永远不会出现组装后的标记
  assert.ok(!wrapped.includes(sentinelBeginMarker(NONCE)), '命令文本不得含组装后的起始标记')
  assert.ok(!wrapped.includes(`__AI_TERM_${NONCE}E__:`), '命令文本不得含组装后的结束标记')
})

test('包装剥掉命令结尾多余的分号,避免 cmd;; printf 语法错误', () => {
  assert.ok(wrapCommandWithSentinel('ls -l;', NONCE).includes('; ls -l; printf'))
  assert.ok(wrapCommandWithSentinel('ls -l ;; ', NONCE).includes('; ls -l; printf'))
})

test('命令行回显本身不会误触发完成', () => {
  const { scanner, finished } = makeScanner()
  // 把包装命令的字面文本(含 %s / %d)整条喂进去
  scanner.push(`${wrapCommandWithSentinel('ls', NONCE)}\r\n`)
  assert.equal(finished.length, 0, '含 %s 的回显不得匹配组装后的标记')
})

test('完整流程:取出区间输出与退出码', () => {
  const { scanner, finished } = makeScanner()
  scanner.push(streamFor('ls', 'file-a\nfile-b\n', 0))
  assert.equal(finished.length, 1)
  assert.equal(finished[0].output, 'file-a\nfile-b')
  assert.equal(finished[0].exitCode, 0)
  assert.equal(finished[0].truncated, false)
})

test('非零与多位退出码', () => {
  for (const code of [1, 7, 127, 130]) {
    const { scanner, finished } = makeScanner()
    scanner.push(streamFor('false', 'boom\n', code))
    assert.equal(finished[0].exitCode, code, `退出码 ${code}`)
  }
})

test('标记被切在两个数据块之间仍能识别', () => {
  const stream = streamFor('ls', 'out\n', 3)
  const cut = stream.indexOf(`__AI_TERM_${NONCE}E__`) + 6
  const { scanner, finished } = makeScanner()
  scanner.push(stream.slice(0, cut))
  assert.equal(finished.length, 0, '切断处不应提前完成')
  scanner.push(stream.slice(cut))
  assert.equal(finished.length, 1)
  assert.equal(finished[0].exitCode, 3)
  assert.equal(finished[0].output, 'out')
})

test('起始标记被切断同样能识别', () => {
  const stream = streamFor('ls', 'out\n', 0)
  const cut = stream.indexOf(sentinelBeginMarker(NONCE)) + 5
  const { scanner, finished } = makeScanner()
  scanner.push(stream.slice(0, cut))
  scanner.push(stream.slice(cut))
  assert.equal(finished.length, 1)
  assert.equal(finished[0].output, 'out')
})

test('逐字符投喂(最坏分片)', () => {
  const stream = streamFor('ls', 'abc\n', 5)
  const { scanner, finished } = makeScanner()
  for (const ch of stream) scanner.push(ch)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].exitCode, 5)
  assert.equal(finished[0].output, 'abc')
})

test('剥离 ANSI 颜色码与 OSC,归一 CRLF', () => {
  const body = '\x1b[32mgreen\x1b[0m\r\nplain\r\n\x1b]0;title\x07'
  const { scanner, finished } = makeScanner()
  scanner.push(streamFor('ls', body, 0))
  assert.equal(finished[0].output, 'green\nplain')
})

test('输出不以换行结尾时标记仍独占一行', () => {
  const { scanner, finished } = makeScanner()
  scanner.push(streamFor('printf x', 'no-trailing-newline', 0))
  assert.equal(finished[0].output, 'no-trailing-newline')
})

test('输出内容里出现包装命令字面量(history / ps 撞见自己)不误判', () => {
  const selfText = `  501 ${wrapCommandWithSentinel('ls', NONCE)}\n`
  const { scanner, finished } = makeScanner()
  scanner.push(streamFor('history', `${selfText}real-line\n`, 0))
  assert.equal(finished.length, 1)
  assert.ok(finished[0].output.includes('real-line'), '完成点应在真正的结束标记处')
  assert.ok(finished[0].output.includes('%s'), '含 %s 的历史行属于正常输出,应保留')
})

test('裸 \\r 按回到行首处理,进度条只留最终帧', () => {
  const { scanner, finished } = makeScanner()
  scanner.push(streamFor('curl', 'kept\n 10%\r 50%\r100% done\n', 0))
  assert.equal(finished[0].output, 'kept\n100% done')
})

test('超长输出触发截断,peekOutput 在完成前可读', () => {
  const { scanner, finished } = makeScanner({ maxOutputChars: 200 })
  const wrapped = wrapCommandWithSentinel('cat big', NONCE)
  scanner.push(`${wrapped}\r\n\n${sentinelBeginMarker(NONCE)}\n`)
  scanner.push(`${'x'.repeat(500)}\n`)

  const peeked = scanner.peekOutput()
  assert.ok(peeked.length > 0, '完成前应能读到部分输出')
  assert.ok(peeked.includes('已截断命令输出'), '部分输出也按上限截断')
  assert.equal(finished.length, 0)

  scanner.push(`\n__AI_TERM_${NONCE}E__:0\n`)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].truncated, true)
  assert.ok(finished[0].output.includes('已截断命令输出'))
})

test('未完成时 peekOutput 为空;dispose 后不再回调', () => {
  const { scanner, finished } = makeScanner()
  assert.equal(scanner.peekOutput(), '', '起始标记未到时无部分输出')
  scanner.dispose()
  scanner.push(streamFor('ls', 'out\n', 0))
  assert.equal(finished.length, 0, 'dispose 后不得回调')
})

test('结束标记只认数字退出码', () => {
  const { scanner, finished } = makeScanner()
  scanner.push(`\n${sentinelBeginMarker(NONCE)}\n`)
  scanner.push(`\n__AI_TERM_${NONCE}E__:%d\n`)
  assert.equal(finished.length, 0, '字面 %d 不是退出码')
  scanner.push(`\n__AI_TERM_${NONCE}E__:0\n`)
  assert.equal(finished.length, 1)
})

test('nonce 为 8 位十六进制且随机源可注入', () => {
  assert.equal(createSentinelNonce(() => 0), '00000000')
  assert.match(createSentinelNonce(), /^[0-9a-f]{8}$/)
})

test('探针命令验证 printf、$? 与标记往返', () => {
  const probe = buildSentinelProbeCommand(NONCE)
  assert.ok(probe.includes(`(exit ${SENTINEL_PROBE_EXIT_CODE})`))
  const { scanner, finished } = makeScanner()
  scanner.push(streamFor(`(exit ${SENTINEL_PROBE_EXIT_CODE})`, '', SENTINEL_PROBE_EXIT_CODE))
  assert.equal(finished[0].exitCode, SENTINEL_PROBE_EXIT_CODE)
  assert.equal(finished[0].output, '', '探针无输出')
})

test('结构守卫:拒绝无法安全追加哨兵的命令', () => {
  assert.equal(isSuffixSafeForSentinel('ls -l').ok, true)
  assert.equal(isSuffixSafeForSentinel('ps aux | grep node').ok, true)
  assert.equal(isSuffixSafeForSentinel('cd /tmp && ls').ok, true)
  assert.equal(isSuffixSafeForSentinel('ls -l;').ok, true, '结尾分号可安全剥离')
  assert.equal(isSuffixSafeForSentinel("echo 'a & b'").ok, true, '引号内的 & 不是分隔符')
  assert.equal(isSuffixSafeForSentinel('echo done\\&').ok, true, '转义的 & 是字面量')

  assert.equal(isSuffixSafeForSentinel('').ok, false)
  assert.equal(isSuffixSafeForSentinel("echo 'unclosed").ok, false)
  assert.equal(isSuffixSafeForSentinel('cat <<EOF').ok, false)
  assert.equal(isSuffixSafeForSentinel('sleep 60 &').ok, false, '后台 & 结尾')
  assert.equal(isSuffixSafeForSentinel('ls |').ok, false, '悬空管道')
  assert.equal(isSuffixSafeForSentinel('ls &&').ok, false, '悬空 &&')
  assert.equal(isSuffixSafeForSentinel('ls ||').ok, false, '悬空 ||')
  assert.equal(isSuffixSafeForSentinel('ls \\').ok, false, '行尾续行反斜杠')

  for (const bad of ['sleep 60 &', 'ls |', 'cat <<EOF', "echo 'unclosed"]) {
    assert.ok(isSuffixSafeForSentinel(bad).reason, `${bad} 应带原因说明`)
  }
})
