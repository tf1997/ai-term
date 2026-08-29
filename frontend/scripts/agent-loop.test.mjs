import assert from 'node:assert/strict'
import test from 'node:test'

import { compressAgentTurns, runAgentTask } from '../src/lib/agentLoop.ts'

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

function toolCall(id, command, reason = '测试理由') {
  return { id, name: 'run_command', arguments: JSON.stringify({ command, reason }) }
}

function turnResponse(text, toolCalls = []) {
  return { text, toolCalls, contextCompressed: false, contextChars: 0 }
}

function completedResult(overrides = {}) {
  return { status: 'completed', output: 'ok', exitCode: 0, durationMs: 5, truncated: false, ...overrides }
}

function makeSimpleHandle(resultOverrides) {
  return {
    result: Promise.resolve(completedResult(resultOverrides)),
    peekOutput: () => '',
    cancel: () => {}
  }
}

// 按脚本逐轮返回模型响应,并记录每次调用时的轮次快照
function scriptedModel(script) {
  const calls = []
  const remaining = script.slice()
  const callModel = async (turns, signal) => {
    calls.push({ turns: structuredClone(turns), signal })
    const next = remaining.shift()
    if (!next) throw new Error('超出脚本的额外模型调用')
    return next
  }
  return { calls, callModel }
}

function makeDeps(overrides = {}) {
  const states = []
  const deps = {
    callModel: async () => turnResponse('', []),
    startCommand: () => makeSimpleHandle(),
    classifyStep: () => ({ risks: [], sensitive: false, autoExec: { eligible: false, suggestedPatterns: ['noop'] } }),
    requestApproval: async () => 'execute',
    requestTimeoutDecision: async () => 'stop',
    onAllowPattern: () => {},
    onStateChange: (snapshot) => states.push(snapshot),
    ...overrides
  }
  return { deps, states }
}

test('两步任务 happy path:toolResult 逐轮回传给模型', async () => {
  const { calls, callModel } = scriptedModel([
    turnResponse('先看目录', [toolCall('c1', 'ls -la')]),
    turnResponse('再看磁盘', [toolCall('c2', 'df -h')]),
    turnResponse('检查完成', [])
  ])
  const outputs = { 'ls -la': 'file-a', 'df -h': 'disk-ok' }
  const { deps, states } = makeDeps({
    callModel,
    startCommand: (command) => makeSimpleHandle({ output: outputs[command], durationMs: 7 })
  })
  const run = runAgentTask('检查磁盘', deps)
  const state = await run.done

  assert.equal(state.status, 'done')
  assert.equal(state.finalText, '检查完成')
  assert.equal(state.steps.length, 2)
  assert.deepEqual(state.steps.map((step) => step.status), ['completed', 'completed'])
  assert.equal(state.steps[0].output, 'file-a')
  assert.equal(state.steps[1].command, 'df -h')

  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0].turns, [])
  // 第二轮请求应带上首轮 assistant 轮次与对应 toolResult
  const secondTurns = calls[1].turns
  assert.equal(secondTurns.length, 2)
  assert.equal(secondTurns[0].kind, 'assistant')
  assert.equal(secondTurns[0].text, '先看目录')
  assert.equal(secondTurns[0].toolCalls[0].id, 'c1')
  assert.equal(secondTurns[1].kind, 'toolResult')
  assert.equal(secondTurns[1].toolCallId, 'c1')
  assert.deepEqual(JSON.parse(secondTurns[1].content), {
    exitCode: 0,
    durationMs: 7,
    truncated: false,
    output: 'file-a'
  })
  assert.equal(calls[2].turns.length, 4)

  // onStateChange 快照是克隆:篡改快照不影响最终状态
  states[0].finalText = '被篡改'
  states[0].steps.push({ id: 'fake' })
  assert.equal(state.finalText, '检查完成')
  assert.equal(state.steps.length, 2)
  assert.ok(states.some((snapshot) => snapshot.status === 'awaiting-approval'))
  assert.ok(states.some((snapshot) => snapshot.status === 'executing'))
})

test('跳过步骤:模型收到 skipped_by_user 并继续', async () => {
  const { calls, callModel } = scriptedModel([
    turnResponse('试试重启', [toolCall('c1', 'systemctl restart nginx')]),
    turnResponse('那先到此为止', [])
  ])
  const { deps } = makeDeps({ callModel, requestApproval: async () => 'skip' })
  const state = await runAgentTask('处理 nginx', deps).done

  assert.equal(state.status, 'done')
  assert.equal(state.steps[0].status, 'skipped')
  assert.deepEqual(JSON.parse(calls[1].turns[1].content), { status: 'skipped_by_user' })
})

test('审批中 stop:未决审批作废,任务收尾为 stopped', async () => {
  let run
  const { calls, callModel } = scriptedModel([
    turnResponse('要执行', [toolCall('c1', 'echo hi')])
  ])
  const { deps, states } = makeDeps({
    callModel,
    requestApproval: () => {
      setTimeout(() => run.stop(), 0)
      return new Promise(() => {})
    }
  })
  run = runAgentTask('测试', deps)
  const state = await run.done

  assert.equal(state.status, 'stopped')
  assert.equal(calls.length, 1)
  assert.ok(states.some((snapshot) => snapshot.status === 'awaiting-approval'))
})

test('callModel 中 stop:signal.cancelled 变 true 且状态 stopped', async () => {
  let seenSignal
  const { deps } = makeDeps({
    callModel: (turns, signal) => {
      seenSignal = signal
      return new Promise(() => {})
    }
  })
  const run = runAgentTask('测试', deps)
  await tick()
  assert.equal(seenSignal.cancelled, false)
  run.stop()
  const state = await run.done

  assert.equal(state.status, 'stopped')
  assert.equal(seenSignal.cancelled, true)
})

test('自动执行:eligible 时不调用审批且步骤标注 autoApproved', async () => {
  let approvalCalls = 0
  const { callModel } = scriptedModel([
    turnResponse('看看目录', [toolCall('c1', 'ls')]),
    turnResponse('好了', [])
  ])
  const { deps, states } = makeDeps({
    callModel,
    classifyStep: () => ({ risks: [], sensitive: false, autoExec: { eligible: true, matched: 'ls', suggestedPatterns: [] } }),
    requestApproval: async () => {
      approvalCalls += 1
      return 'execute'
    }
  })
  const state = await runAgentTask('测试', deps).done

  assert.equal(state.status, 'done')
  assert.equal(approvalCalls, 0)
  assert.equal(state.steps[0].autoApproved, true)
  assert.equal(state.steps[0].status, 'completed')
  assert.ok(!states.some((snapshot) => snapshot.status === 'awaiting-approval'))
})

test('execute-and-allow:onAllowPattern 先收到 pattern 与来源命令再执行', async () => {
  const allowed = []
  const proposals = []
  const events = []
  const { callModel } = scriptedModel([
    turnResponse('查状态', [toolCall('c1', 'git status --porcelain')]),
    turnResponse('工作区干净', [])
  ])
  const { deps } = makeDeps({
    callModel,
    classifyStep: () => ({ risks: [], sensitive: false, autoExec: { eligible: false, suggestedPatterns: ['git status'] } }),
    requestApproval: async (proposal) => {
      proposals.push(proposal)
      return 'execute-and-allow'
    },
    onAllowPattern: (pattern, sourceCommand) => {
      events.push('allow')
      allowed.push([pattern, sourceCommand])
    },
    startCommand: () => {
      events.push('start')
      return makeSimpleHandle()
    }
  })
  const state = await runAgentTask('测试', deps).done

  assert.equal(state.status, 'done')
  assert.deepEqual(proposals[0].suggestedPatterns, ['git status'])
  assert.deepEqual(allowed, [['git status', 'git status --porcelain']])
  assert.deepEqual(events, ['allow', 'start'], '允许列表先落地,命令后派发')
  assert.equal(state.steps[0].status, 'completed')
})

test('execute-and-allow:多段命令的每个 pattern 都要落地', async () => {
  // 回归:只写第一段会让「总是允许」下次依旧要人工审批
  const allowed = []
  const { callModel } = scriptedModel([
    turnResponse('采样', [toolCall('c1', "memory_pressure | printf 'x'")]),
    turnResponse('完成', [])
  ])
  const { deps } = makeDeps({
    callModel,
    classifyStep: () => ({
      risks: [],
      sensitive: false,
      autoExec: { eligible: false, suggestedPatterns: ['memory_pressure', 'printf'] }
    }),
    requestApproval: async () => 'execute-and-allow',
    onAllowPattern: (pattern, sourceCommand) => {
      allowed.push([pattern, sourceCommand])
    }
  })
  const state = await runAgentTask('测试', deps).done

  assert.equal(state.status, 'done')
  assert.deepEqual(allowed, [
    ['memory_pressure', "memory_pressure | printf 'x'"],
    ['printf', "memory_pressure | printf 'x'"]
  ])
})

test('敏感命令:即使 eligible 也必须人工审批且不提供总是允许', async () => {
  const proposals = []
  const { callModel } = scriptedModel([
    turnResponse('读取密钥', [toolCall('c1', 'cat ~/.ssh/id_rsa')]),
    turnResponse('完成', [])
  ])
  const { deps, states } = makeDeps({
    callModel,
    classifyStep: () => ({ risks: [], sensitive: true, autoExec: { eligible: true, matched: 'cat', suggestedPatterns: [] } }),
    requestApproval: async (proposal) => {
      proposals.push(proposal)
      return 'execute'
    }
  })
  const state = await runAgentTask('测试', deps).done

  assert.equal(state.status, 'done')
  assert.equal(proposals.length, 1)
  assert.equal(proposals[0].suggestedPatterns, undefined)
  assert.equal(proposals[0].sensitive, true)
  assert.notEqual(state.steps[0].autoApproved, true)
  assert.ok(states.some((snapshot) => snapshot.status === 'awaiting-approval'))
})

test('invalid_arguments 一次后恢复:回传错误说明并继续', async () => {
  const { calls, callModel } = scriptedModel([
    turnResponse('坏参数', [{ id: 'bad1', name: 'run_command', arguments: '{oops' }]),
    turnResponse('修正', [toolCall('c2', 'echo ok')]),
    turnResponse('完成', [])
  ])
  const { deps } = makeDeps({ callModel })
  const state = await runAgentTask('测试', deps).done

  assert.equal(state.status, 'done')
  const invalidResult = JSON.parse(calls[1].turns[1].content)
  assert.equal(invalidResult.status, 'invalid_arguments')
  assert.ok(invalidResult.error.length > 0)
  assert.equal(calls[1].turns[1].toolCallId, 'bad1')
  // 解析失败不产生步骤;成功解析清零计数并正常执行
  assert.equal(state.steps.length, 1)
  assert.equal(state.steps[0].status, 'completed')
})

test('连续两次 invalid_arguments:任务以 error 结束', async () => {
  const { callModel } = scriptedModel([
    turnResponse('坏1', [{ id: 'b1', name: 'run_command', arguments: 'nope' }]),
    turnResponse('坏2', [{ id: 'b2', name: 'run_command', arguments: '{"command":"  "}' }])
  ])
  const { deps } = makeDeps({ callModel })
  const state = await runAgentTask('测试', deps).done

  assert.equal(state.status, 'error')
  assert.ok(state.error)
  assert.equal(state.steps.length, 0)
})

test('callModel 抛异常:状态 error 且 error 为异常信息', async () => {
  const { deps } = makeDeps({
    callModel: async () => {
      throw new Error('网关超载')
    }
  })
  const state = await runAgentTask('测试', deps).done

  assert.equal(state.status, 'error')
  assert.equal(state.error, '网关超载')
})

test('步数上限:达到后不再调模型,finalText 带说明', async () => {
  let modelCalls = 0
  const { deps } = makeDeps({
    callModel: async () => {
      modelCalls += 1
      return turnResponse(`第${modelCalls}轮`, [toolCall(`c${modelCalls}`, 'echo x')])
    }
  })
  const state = await runAgentTask('测试', deps, { stepLimit: 2 }).done

  assert.equal(state.status, 'stopped')
  assert.equal(modelCalls, 2)
  assert.equal(state.steps.length, 2)
  assert.ok(state.finalText.includes('已达到 2 步上限'))
  assert.ok(state.finalText.includes('任务未确认完成'))
})

test('超时后选择继续等待:命令完成后任务继续', async () => {
  const waited = []
  let resolveResult
  const pendingHandle = {
    result: new Promise((resolve) => {
      resolveResult = resolve
    }),
    peekOutput: () => '部分输出',
    cancel: () => {}
  }
  const { callModel } = scriptedModel([
    turnResponse('慢命令', [toolCall('c1', 'sleep 999')]),
    turnResponse('完成', [])
  ])
  const { deps, states } = makeDeps({
    callModel,
    startCommand: () => pendingHandle,
    requestTimeoutDecision: async (step, waitedMs) => {
      waited.push([step.id, step.status, waitedMs])
      setTimeout(() => resolveResult(completedResult({ output: '慢结果', durationMs: 30 })), 0)
      return 'wait'
    }
  })
  const state = await runAgentTask('测试', deps, { commandTimeoutMs: 10 }).done

  assert.equal(state.status, 'done')
  assert.deepEqual(waited, [['c1', 'running', 10]])
  assert.equal(state.steps[0].status, 'completed')
  assert.equal(state.steps[0].output, '慢结果')
  assert.ok(states.some((snapshot) => snapshot.status === 'awaiting-user'))
})

test('超时后选择停止:handle.cancel 被调、步骤 timeout、任务 stopped', async () => {
  let cancelCalls = 0
  const pendingHandle = {
    result: new Promise(() => {}),
    peekOutput: () => '',
    cancel: () => {
      cancelCalls += 1
    }
  }
  const { callModel } = scriptedModel([
    turnResponse('慢命令', [toolCall('c1', 'sleep 999')])
  ])
  const { deps } = makeDeps({
    callModel,
    startCommand: () => pendingHandle,
    requestTimeoutDecision: async () => 'stop'
  })
  const state = await runAgentTask('测试', deps, { commandTimeoutMs: 10 }).done

  assert.equal(state.status, 'stopped')
  assert.equal(cancelCalls, 1)
  assert.equal(state.steps[0].status, 'timeout')
})

test('commandMismatch:按串扰处理,任务 stopped 并带说明', async () => {
  const { callModel } = scriptedModel([
    turnResponse('执行', [toolCall('c1', 'echo hi')])
  ])
  const { deps } = makeDeps({
    callModel,
    startCommand: () => makeSimpleHandle({ commandMismatch: true })
  })
  const state = await runAgentTask('测试', deps).done

  assert.equal(state.status, 'stopped')
  assert.equal(state.steps[0].status, 'failed')
  assert.ok(state.error && state.error.includes('串扰'))
})

test('轮次压缩:最旧 toolResult 保留退出码与输出尾部,最近 6 轮保留', () => {
  const bigOutput = 'x'.repeat(500) + 'TAIL-MARKER'
  const turns = [
    { kind: 'assistant', text: 'a'.repeat(300), toolCalls: [{ id: 't1', name: 'run_command', arguments: '{}' }] },
    { kind: 'toolResult', toolCallId: 't1', content: JSON.stringify({ exitCode: 0, durationMs: 9, truncated: false, output: bigOutput }) },
    { kind: 'toolResult', toolCallId: 't2', content: 'y'.repeat(400) },
    // 以下 6 轮受 PROTECTED_RECENT_TURNS 保护
    { kind: 'assistant', text: 'b'.repeat(300), toolCalls: [] },
    { kind: 'toolResult', toolCallId: 't3', content: 'z'.repeat(300) },
    { kind: 'assistant', text: 'c'.repeat(300), toolCalls: [] },
    { kind: 'toolResult', toolCallId: 't4', content: 'w'.repeat(300) },
    { kind: 'assistant', text: 'd'.repeat(300), toolCalls: [] },
    { kind: 'assistant', text: '最新总结', toolCalls: [] }
  ]
  const snapshot = structuredClone(turns)
  const compressed = compressAgentTurns(turns, 100)

  assert.deepEqual(turns, snapshot, '入参不被修改')
  assert.equal(compressed[0].text.length, 200, 'Assistant 文本截到 200 字符')
  assert.deepEqual(compressed[0].toolCalls, snapshot[0].toolCalls)

  // 探索型任务依赖证据链:退出码与输出尾部必须留下,不能整体丢弃
  const kept = JSON.parse(compressed[1].content)
  assert.equal(kept.exitCode, 0, '解析出 exitCode')
  assert.equal(kept.note, '仅保留输出尾部')
  assert.equal(kept.output.length, 300, '尾部保留 300 字符')
  assert.ok(kept.output.endsWith('TAIL-MARKER'), '保留的是尾部而非头部')

  assert.deepEqual(JSON.parse(compressed[2].content), { note: '输出已省略' }, '非 JSON 结果退化为仅保留说明')
  assert.deepEqual(compressed.slice(3), snapshot.slice(3), '最近 6 轮原样保留')
})

test('轮次压缩:未超限原样返回,降到限内即停止', () => {
  const turns = [
    { kind: 'toolResult', toolCallId: 'a', content: 'x'.repeat(300) },
    { kind: 'toolResult', toolCallId: 'b', content: 'y'.repeat(300) },
    { kind: 'assistant', text: '1', toolCalls: [] },
    { kind: 'assistant', text: '2', toolCalls: [] },
    { kind: 'assistant', text: '3', toolCalls: [] }
  ]
  assert.equal(compressAgentTurns(turns, 10_000), turns, '未超限返回原数组')

  // 6 轮以内全部受保护,压缩不生效;超过保护窗口才会压缩最旧轮次
  const longTurns = [
    { kind: 'toolResult', toolCallId: 'a', content: 'x'.repeat(300) },
    { kind: 'toolResult', toolCallId: 'b', content: 'y'.repeat(300) },
    ...turns
  ]
  const compressed = compressAgentTurns(longTurns, 400)
  assert.deepEqual(JSON.parse(compressed[0].content), { note: '输出已省略' })
  assert.equal(compressed[1].content, 'y'.repeat(300), '已降到限内,后续轮次不再压缩')
})

test('轮次压缩:短输出不会因压缩而膨胀', () => {
  // 防膨胀保护:占位比原文还长时保持原样,短输出因此完整留存
  const original = JSON.stringify({ exitCode: 1, output: 'permission denied' })
  const turns = [
    { kind: 'toolResult', toolCallId: 'a', content: original },
    ...Array.from({ length: 6 }, () => ({ kind: 'assistant', text: 'p'.repeat(200), toolCalls: [] }))
  ]
  const compressed = compressAgentTurns(turns, 100)
  assert.equal(compressed[0].content, original, '压缩占位更长时保持原样')
})
