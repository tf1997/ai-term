import assert from 'node:assert/strict'
import test from 'node:test'
import { createDeferredAgentCommand } from "../../src/domains/terminal/model/deferredAgentCommand"

function deferred() {
  let resolve
  return { promise: new Promise((done) => { resolve = done }), resolve }
}

test('探针期间停止后不执行真实命令', async () => {
  const gate = deferred()
  let starts = 0
  const handle = createDeferredAgentCommand(
    () => gate.promise,
    () => {
      starts += 1
      throw new Error('不应执行')
    }
  )

  handle.cancel()
  gate.resolve('')
  const result = await handle.result
  assert.equal(starts, 0)
  assert.equal(result.status, 'cancelled')
})

test('探针成功后代理真实句柄及取消和部分输出', async () => {
  const gate = deferred()
  const command = deferred()
  let cancelCalls = 0
  const handle = createDeferredAgentCommand(
    () => gate.promise,
    () => ({
      result: command.promise,
      peekOutput: () => 'partial',
      cancel: () => { cancelCalls += 1 }
    })
  )

  gate.resolve('')
  await Promise.resolve()
  assert.equal(handle.peekOutput(), 'partial')
  handle.cancel()
  assert.equal(cancelCalls, 1)
  command.resolve({ status: 'cancelled', output: 'partial', durationMs: 1, truncated: false })
  assert.equal((await handle.result).status, 'cancelled')
})

test('探针失败或抛错均返回派发失败', async () => {
  for (const preflight of [
    async () => '不支持当前 shell',
    async () => { throw new Error('探针异常') }
  ]) {
    let starts = 0
    const handle = createDeferredAgentCommand(preflight, () => {
      starts += 1
      throw new Error('不应执行')
    })
    const result = await handle.result
    assert.equal(starts, 0)
    assert.equal(result.status, 'dispatch-failed')
    assert.ok(result.failureReason)
  }
})
