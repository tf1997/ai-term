import assert from 'node:assert/strict'
import test from 'node:test'
import { createShellCaptureVerification } from '../../src/domains/terminal/domain/shellCaptureVerification'

const osc = value => `\x1b]133;${value}\x07`
const frame = nonce => `\r\n__AI_TERM_${nonce}B__\r\nAI_TERM_CAPTURE_OK\r\n\r\n__AI_TERM_${nonce}E__:7\r\n`
const lifecycle = osc('C') + frame('fresh') + osc('D;7') + osc('A') + 'prompt> ' + osc('B')

test('完整的开始、随机输出帧、退出码和输入提示符才启用标记捕获', () => {
  for (let split = 0; split <= lifecycle.length; split++) {
    const probe = createShellCaptureVerification('fresh')
    probe.push(lifecycle.slice(0, split)); probe.push(lifecycle.slice(split))
    assert.equal(probe.verified(), true, `split ${split}`)
  }
  const probe = createShellCaptureVerification('fresh')
  for (const char of lifecycle.replaceAll('\x07', '\x1b\\')) probe.push(char)
  assert.equal(probe.verified(), true)
})

test('部分标记、旧 nonce、被提示符覆盖的退出码和缺少输出均不能验证', () => {
  for (const output of [osc('A') + osc('B'), frame('fresh'), lifecycle.replace(osc('C'), ''),
    lifecycle.replaceAll('fresh', 'stale'), lifecycle.replace('D;7', 'D;0'),
    lifecycle.replace(osc('A'), ''), lifecycle.replace(osc('B'), ''),
    lifecycle.replace('AI_TERM_CAPTURE_OK', ''), lifecycle.replace(osc('D;7'), osc('D'))]) {
    const probe = createShellCaptureVerification('fresh')
    probe.push(output)
    assert.equal(probe.verified(), false)
  }
})

test('额外命令开始和超预算响应不能拼接成成功探测', () => {
  const probe = createShellCaptureVerification('fresh')
  probe.push(osc('C') + frame('fresh') + osc('C') + osc('D;7') + osc('A') + osc('B'))
  assert.equal(probe.verified(), false)
  probe.push('x'.repeat(70_000) + lifecycle)
  assert.equal(probe.verified(), false)
})

test('multiline negotiation accepts repeated Bash starts but requires one final exit and both outputs', () => {
  const body = `\r\n__AI_TERM_freshB__\r\nAI_TERM_MULTILINE_FIRST\r\n${osc('C')}\nAI_TERM_CAPTURE_OK\r\n${osc('C')}\n__AI_TERM_freshE__:7\r\n`
  const output = osc('C') + body + osc('D;7') + osc('A') + osc('B')
  for (let split = 0; split <= output.length; split++) {
    const probe = createShellCaptureVerification('fresh', true)
    probe.push(output.slice(0, split)); probe.push(output.slice(split)); assert.equal(probe.verified(), true, `split ${split}`)
  }
  for (const changed of [output.replace('AI_TERM_MULTILINE_FIRST', ''), output.replace('AI_TERM_CAPTURE_OK', ''), output.replace('AI_TERM_MULTILINE_FIRST\r\n', 'AI_TERM_MULTILINE_FIRST\r\n' + osc('D;0')), output.replace(osc('D;7'), osc('C') + osc('D;7'))]) {
    const probe = createShellCaptureVerification('fresh', true); probe.push(changed); assert.equal(probe.verified(), false)
  }
})
