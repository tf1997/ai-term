import assert from 'node:assert/strict'
import test from 'node:test'
import { createDeferredAgentCommand, createReadyAgentCommand } from "../../src/domains/terminal/domain/deferredAgentCommand"

function deferred() {
  let resolve
  return { promise: new Promise((done) => { resolve = done }), resolve }
}

test('快照结束后等待提示符，保留终端绑定、输入和取消防护', async () => {
  let readiness = 'shell-busy', starts = 0
  const start = () => { starts++; return { result: Promise.resolve({ status: 'completed' }), cancel() {}, peekOutput: () => '' } }
  const handle = createReadyAgentCommand(() => readiness, () => '', start)
  assert.equal(starts, 0)
  readiness = 'ready'
  assert.equal((await handle.result).status, 'completed'); assert.equal(starts, 1)
  for (const [status, guard] of [['line-busy', ''], ['unavailable', ''], ['ready', '终端已重连'], ['shell-busy', '']]) {
    const blocked = createReadyAgentCommand(() => status, () => guard, start, 5)
    assert.equal((await blocked.result).status, 'dispatch-failed')
  }
  readiness = 'shell-busy'
  const cancelled = createReadyAgentCommand(() => readiness, () => '', start)
  cancelled.cancel(); readiness = 'ready'
  assert.equal((await cancelled.result).status, 'cancelled'); assert.equal(starts, 1)
})

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
