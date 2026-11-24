import assert from 'node:assert/strict'
import test from 'node:test'
import { createSentinelDisplayFilter } from '../../src/domains/terminal/domain/sentinelDisplayFilter'
import { wrapCommandWithSentinel } from '../../src/domains/terminal/domain/agentSentinelCapture'
const nonce = 'unique123'
const input = "printf begin; eval 'printf hello'; printf end\r"
const source = 'printf hello'
const stream = input + '\n\r\n__AI_TERM_unique123B__\r\nhello\r\n\r\n__AI_TERM_unique123E__:7\r\nprompt$ '

test('只清理本次 nonce 的标记，并将精确包装回显还原为原始命令', () => {
  for (let split = 0; split <= stream.length; split++) {
    const filter = createSentinelDisplayFilter()
    filter.begin(nonce, input, source, false)
    const actual = filter.push(stream.slice(0, split)) + filter.push(stream.slice(split))
    assert.equal(actual, 'printf hello\r\nhello\r\n\r\nprompt$ ', `split ${split}`)
  }
})

test('Readline wrap-padding does not expose the sentinel wrapper in long command echoes', () => {
  const nonce = 'long_wrapped_echo'
  const source = 'echo "== free -m =="; free -m | head -n 3; echo "== cluster YGC =="; jcmd 46806 PerfCounter.print 2>/dev/null | grep -E "^sun.gc.collector.[01].(invocations|time)|^sun.gc.cause"'
  const input = wrapCommandWithSentinel(source, nonce)
  let echo = ''
  for (let index = 0; index < input.length; index += 80) {
    echo += input.slice(index, index + 80)
    if (index + 80 < input.length) echo += ' \r'
  }
  echo += '\r\n'
  const stream = `${echo}\r\n__AI_TERM_${nonce}B__\r\nfree output\r\n\r\n__AI_TERM_${nonce}E__:0\r\nprompt$ `
  const filter = createSentinelDisplayFilter()
  filter.begin(nonce, `${input}\r`, source, false)
  assert.equal([...stream].map(character => filter.push(character)).join(''), `${source}\r\nfree output\r\n\r\nprompt$ `)
})

test('用户输出、未知回显和相似标记不被删除', () => {
  const body = 'async notification\r\n\r\n__AI_TERM_unique123B__\r\n' +
    '__AI_TERM_someoneE__:0\r\nprefix __AI_TERM_unique123E__:7\r\n__AI_TERM_unique123E__:oops\r\n' +
    '__AI_TERM_unique123E__:0\r\n'
  const filter = createSentinelDisplayFilter()
  filter.begin(nonce, input, source, false)
  let visible = ''
  for (const char of body) visible += filter.push(char)
  assert.equal(visible, 'async notification\r\n\r\n__AI_TERM_someoneE__:0\r\nprefix __AI_TERM_unique123E__:7\r\n__AI_TERM_unique123E__:oops\r\n')
})

test('调试透传；停止、重连和超时释放尚未分类的文本', () => {
  const debug = createSentinelDisplayFilter()
  debug.begin(nonce, input, source, true)
  assert.equal(debug.push(stream), stream)
  let now = 0
  const filter = createSentinelDisplayFilter({ now: () => now })
  filter.begin(nonce, input, source, false)
  assert.equal(filter.push('printf beg'), '')
  assert.equal(filter.resume(), 'printf beg')
  assert.equal(filter.push('visible'), 'visible')
  filter.begin(nonce, input, source, false)
  assert.equal(filter.push('printf beg'), '')
  now = 65_001
  assert.equal(filter.push(''), 'printf beg')
  filter.begin(nonce, input, source, false); filter.push('printf beg'); filter.reset()
  assert.equal(filter.push('new session'), 'new session')
})
