import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compressAgentTurns,
  describeTimeoutHint,
  looksLikeInteractivePrompt,
  runAgentTask
} from "../../src/domains/ai/application/agent/agentLoop"

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
  assert.equal(state.errorKind, 'protocol')
  assert.equal(state.steps.length, 0)
})

test('run_command 是唯一受支持的工具名,异常工具不会执行', async () => {
  let commandStarts = 0
  const { calls, callModel } = scriptedModel([
    turnResponse('误用工具', [{ id: 'bad-tool', name: 'bash', arguments: '{"command":"uptime"}' }]),
    turnResponse('改用正确工具', [toolCall('good-tool', 'uptime')]),
    turnResponse('完成', [])
  ])
  const { deps } = makeDeps({
    callModel,
    startCommand: () => {
      commandStarts += 1
      return makeSimpleHandle()
    }
  })
  const state = await runAgentTask('测试', deps).done

  assert.equal(state.status, 'done')
  assert.equal(commandStarts, 1)
  assert.equal(JSON.parse(calls[1].turns[1].content).status, 'unsupported_tool')
})

test('连续异常工具会返回明确错误而不是空泛的任务出错', async () => {
  const { callModel } = scriptedModel([
    turnResponse('第一次误用', [{ id: 'bad-1', name: 'bash', arguments: '{"command":"uptime"}' }]),
    turnResponse('第二次误用', [{ id: 'bad-2', name: '', arguments: '{"command":"uptime"}' }])
  ])
  const { deps } = makeDeps({ callModel })
  const state = await runAgentTask('测试', deps).done

  assert.equal(state.status, 'error')
  assert.equal(state.errorKind, 'protocol')
  assert.match(state.error, /连续 2 次调用了不支持的工具/)
  assert.match(state.error, /空名称/)
  assert.equal(state.steps.length, 0)
})

test('重试会保留已完成步骤并以 run_command 协议恢复上下文', async () => {
  const initialSteps = [
    {
      id: 'old-completed',
      command: 'df -h',
      reason: '查看磁盘',
      risks: [],
      sensitive: false,
      status: 'completed',
      output: 'disk-ok',
      exitCode: 0,
      durationMs: 12
    },
    {
      id: 'old-skipped',
      command: 'systemctl restart nginx',
      reason: '重启服务',
      risks: [],
      sensitive: false,
      status: 'skipped'
    }
  ]
  const { calls, callModel } = scriptedModel([turnResponse('已有信息足够', [])])
  const { deps } = makeDeps({ callModel })
  const state = await runAgentTask('继续排查', deps, { initialSteps }).done

  assert.equal(state.status, 'done')
  assert.equal(state.steps.length, 2)
  assert.notEqual(state.steps, initialSteps)
  assert.equal(calls[0].turns.length, 4)
  assert.equal(calls[0].turns[0].toolCalls[0].name, 'run_command')
  assert.deepEqual(JSON.parse(calls[0].turns[1].content), {
    exitCode: 0,
    durationMs: 12,
    truncated: false,
    output: 'disk-ok'
  })
  assert.deepEqual(JSON.parse(calls[0].turns[3].content), { status: 'skipped_by_user' })
})

test('失败工具重试时先重新执行命令,成功后才请求模型', async () => {
  const events = []
  const retryStep = {
    id: 'failed-command',
    command: 'systemctl status nginx',
    reason: '查看服务状态',
    risks: [],
    sensitive: false,
    status: 'failed',
    output: 'old failure',
    durationMs: 5
  }
  const { deps } = makeDeps({
    startCommand: (command) => {
      events.push(`command:${command}`)
      return makeSimpleHandle({ output: 'active', durationMs: 9 })
    },
    callModel: async (turns) => {
      events.push('model')
      assert.equal(turns.length, 2)
      assert.equal(turns[0].kind, 'assistant')
      assert.equal(turns[0].toolCalls[0].id, retryStep.id)
      assert.equal(turns[0].toolCalls[0].name, 'run_command')
      assert.deepEqual(JSON.parse(turns[1].content), {
        exitCode: 0,
        durationMs: 9,
        truncated: false,
        output: 'active'
      })
      return turnResponse('重试成功', [])
    }
  })

  const state = await runAgentTask('继续任务', deps, { retryStep }).done

  assert.deepEqual(events, ['command:systemctl status nginx', 'model'])
  assert.equal(state.status, 'done')
  assert.equal(state.steps.length, 1)
  assert.equal(state.steps[0].status, 'completed')
  assert.equal(state.steps[0].output, 'active')
})

test('失败工具重试仍失败时不请求模型', async () => {
  let modelCalls = 0
  const retryStep = {
    id: 'failed-command',
    command: 'systemctl status nginx',
    reason: '查看服务状态',
    risks: [],
    sensitive: false,
    status: 'failed'
  }
  const { deps } = makeDeps({
    startCommand: () => makeSimpleHandle({
      status: 'dispatch-failed',
      failureReason: '终端不可用'
    }),
    callModel: async () => {
      modelCalls += 1
      return turnResponse('不应调用', [])
    }
  })

  const state = await runAgentTask('继续任务', deps, { retryStep }).done

  assert.equal(modelCalls, 0)
  assert.equal(state.status, 'error')
  assert.equal(state.errorKind, 'tool')
  assert.equal(state.steps[0].status, 'failed')
  assert.match(state.error, /终端不可用/)
})

test('非 failed 步骤不会被自动重新执行', async () => {
  let commandStarts = 0
  let modelCalls = 0
  const { deps } = makeDeps({
    startCommand: () => {
      commandStarts += 1
      return makeSimpleHandle()
    },
    callModel: async () => {
      modelCalls += 1
      return turnResponse('保持停止', [])
    }
  })
  const timeoutStep = {
    id: 'possibly-running',
    command: 'deploy.sh',
    reason: '部署',
    risks: [],
    sensitive: false,
    status: 'timeout'
  }

  const state = await runAgentTask('继续任务', deps, { retryStep: timeoutStep }).done

  assert.equal(commandStarts, 0)
  assert.equal(modelCalls, 1)
  assert.equal(state.status, 'done')
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
  assert.equal(state.errorKind, 'model')
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
    requestTimeoutDecision: async (step, info) => {
      waited.push([step.id, step.status, info.waitedMs])
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

test('轮次压缩:幂等,完整保留的输出与跳过状态不会被标成"已省略"', () => {
  const protectedTail = Array.from({ length: 6 }, () => ({ kind: 'assistant', text: 'p'.repeat(200), toolCalls: [] }))
  const turns = [
    { kind: 'toolResult', toolCallId: 'a', content: JSON.stringify({ exitCode: 0, durationMs: 5, truncated: true, output: 'x'.repeat(1000) + 'TAIL' }) },
    { kind: 'toolResult', toolCallId: 'b', content: JSON.stringify({ exitCode: 1, durationMs: 5, truncated: false, output: 'permission denied for /etc/shadow' }) },
    { kind: 'toolResult', toolCallId: 'c', content: JSON.stringify({ status: 'skipped_by_user' }) },
    ...protectedTail
  ]
  const once = compressAgentTurns(turns, 100)
  // 循环每轮都会在已压缩的轮次上重跑:第二遍不能再改动任何内容(标注不翻转,前缀缓存不失效)
  const twice = compressAgentTurns(once, 100)
  assert.deepEqual(twice, once)
  assert.deepEqual(JSON.parse(once[0].content), { exitCode: 0, output: 'x'.repeat(296) + 'TAIL', note: '仅保留输出尾部' })
  assert.deepEqual(JSON.parse(once[1].content), { exitCode: 1, output: 'permission denied for /etc/shadow' }, '完整输出只去掉耗时等字段,不带"已省略"')
  assert.deepEqual(JSON.parse(once[2].content), { status: 'skipped_by_user' }, '跳过状态原样保留')
})

test('模型用量:逐轮累计到 state.usage,未上报用量的轮次不计次数', async () => {
  const { callModel } = scriptedModel([
    { ...turnResponse('看目录', [toolCall('c1', 'ls')]), usage: { inputTokens: 1000, outputTokens: 20, cachedInputTokens: 0 } },
    turnResponse('看磁盘', [toolCall('c2', 'df -h')]),
    { ...turnResponse('完成'), usage: { inputTokens: 2600, outputTokens: 40, cachedInputTokens: 2048 } }
  ])
  const { deps, states } = makeDeps({ callModel })
  const state = await runAgentTask('检查', deps).done

  assert.equal(state.status, 'done')
  assert.deepEqual(state.usage, { inputTokens: 3600, outputTokens: 60, cachedInputTokens: 2048, requests: 2 })
  assert.deepEqual(states.at(-1).usage, state.usage, '快照也带累计值,卡片可实时展示')
})

test('默认 24k 软预算降低长任务的累计回传量,保留最近输出和完整步骤卡片', async (t) => {
  const output = 'x'.repeat(3_980) + 'TAIL-EVIDENCE';
  const runSample = async (options) => {
    const { calls, callModel } = scriptedModel([
      ...Array.from({ length: 20 }, (_, i) => turnResponse(`检查 ${i}`, [toolCall(`c${i}`, `check-${i}`)])),
      turnResponse('完成')
    ]);
    const { deps } = makeDeps({ callModel, startCommand: () => makeSimpleHandle({ output }) });
    const state = await runAgentTask('诊断', deps, options).done;
    assert.equal(state.status, 'done');
    assert.equal(state.steps.length, 20);
    assert.ok(state.steps.every((step) => step.output === output), '压缩只影响模型上下文,不修改步骤输出');
    const totalChars = calls.reduce((sum, call) => sum + call.turns.reduce((n, turn) => n + (
      turn.kind === 'assistant'
        ? turn.text.length + turn.toolCalls.reduce((m, tool) => m + tool.arguments.length, 0)
        : turn.content.length
    ), 0), 0);
    return { calls, totalChars };
  };
  const before = await runSample({ maxTurnChars: 72_000 });
  const after = await runSample({});
  t.diagnostic(`20-step replay characters: ${before.totalChars} -> ${after.totalChars}; reduction ${((1 - after.totalChars / before.totalChars) * 100).toFixed(1)}% (not billed tokens)`);
  assert.ok(after.totalChars < before.totalChars * 0.6, '固定 20 步样本的轮次字符累计量至少下降 40%');
  const finalTurns = after.calls.at(-1).turns;
  assert.equal(finalTurns.length, 40, '工具调用/结果不删除,协议对应关系不变');
  for (let i = 0; i < finalTurns.length; i += 2) {
    assert.equal(finalTurns[i].toolCalls[0].id, finalTurns[i + 1].toolCallId);
    assert.ok(JSON.parse(finalTurns[i + 1].content).output.endsWith('TAIL-EVIDENCE'));
  }
  for (const turn of finalTurns.slice(-6).filter((turn) => turn.kind === 'toolResult')) {
    assert.equal(JSON.parse(turn.content).output, output, '最近三次命令输出完整保留');
  }
});

// —— 超时体验(文档 10.3.2):倒计时字段、静默采样、启发提示 ——

/** 结果长期挂起的句柄,用于逼出超时分支;peekOutput 可注入。 */
function makePendingHandle(peekOutput = () => '') {
  let resolveResult
  const handle = {
    result: new Promise((resolve) => {
      resolveResult = resolve
    }),
    peekOutput,
    cancelCalls: 0,
    cancel() {
      handle.cancelCalls += 1
    },
    finish(result) {
      resolveResult(completedResult(result))
    }
  }
  return handle
}

test('deadlineAt:派发即置位、完成后清除、不进入终态快照', async () => {
  const { callModel } = scriptedModel([
    turnResponse('执行', [toolCall('c1', 'ls')]),
    turnResponse('完成', [])
  ])
  const { deps, states } = makeDeps({ callModel })
  const before = Date.now()
  const state = await runAgentTask('测试', deps, { commandTimeoutMs: 30_000 }).done
  const after = Date.now()

  // 运行中的快照必须带 deadlineAt,否则卡片无从渲染倒计时
  const running = states.filter((snapshot) => snapshot.steps[0]?.status === 'running')
  assert.ok(running.length > 0, '存在 running 快照')
  const armed = running.find((snapshot) => snapshot.steps[0].deadlineAt !== undefined)
  assert.ok(armed, 'running 期间置了 deadlineAt')
  assert.ok(
    armed.steps[0].deadlineAt >= before + 30_000 && armed.steps[0].deadlineAt <= after + 30_000,
    'deadlineAt = 派发时刻 + commandTimeoutMs'
  )

  // 结算即清除:该字段是运行态,不能随 payloadJson 落库(否则历史消息会残留倒计时)
  assert.equal(state.steps[0].status, 'completed')
  assert.equal(state.steps[0].deadlineAt, undefined, '完成后 deadlineAt 被清除')
})

test('deadlineAt:「继续等待」把下次询问时刻推后(倒计时复位)', async () => {
  const deadlines = []
  const handle = makePendingHandle()
  const { callModel } = scriptedModel([
    turnResponse('慢命令', [toolCall('c1', 'sleep 999')])
  ])
  const { deps } = makeDeps({
    callModel,
    startCommand: () => handle,
    requestTimeoutDecision: async (step) => {
      deadlines.push(step.deadlineAt)
      return deadlines.length === 1 ? 'wait' : 'stop'
    }
  })
  const state = await runAgentTask('测试', deps, { commandTimeoutMs: 20, outputSampleIntervalMs: 5 }).done

  assert.equal(deadlines.length, 2, '两次超时询问')
  assert.ok(deadlines[0] !== undefined && deadlines[1] !== undefined)
  assert.ok(deadlines[1] > deadlines[0], '「继续等待」后 deadlineAt 被推后,倒计时复位')
  assert.ok(deadlines[1] - deadlines[0] >= 20, '推后幅度至少一个超时周期')
  // 超时选停止后同样清除,不留残余倒计时
  assert.equal(state.steps[0].deadlineAt, undefined)
  assert.equal(state.steps[0].status, 'timeout')
})

test('超时判据:输出仍在增长时 outputGrowing 为真,文案说"持续输出"', async () => {
  let peeks = 0
  // 每次采样都更长:超时那一刻的采样即视为刚刚增长
  const handle = makePendingHandle(() => 'x'.repeat(++peeks * 10))
  const { callModel } = scriptedModel([
    turnResponse('长输出', [toolCall('c1', 'ping example.com')])
  ])
  let seen
  const { deps } = makeDeps({
    callModel,
    startCommand: () => handle,
    requestTimeoutDecision: async (step, info) => {
      seen = info
      return 'stop'
    }
  })
  // 采样周期远大于超时:排除 setInterval 参与,判据只由派发基线与超时采样决定
  await runAgentTask('测试', deps, { commandTimeoutMs: 20, outputSampleIntervalMs: 500 }).done

  assert.equal(seen.outputGrowing, true)
  assert.equal(seen.likelyInteractive, false, '仍在输出时不判为等待输入')
  assert.ok(seen.hint.includes('仍在持续输出'), `文案应指向持续输出:${seen.hint}`)
  assert.ok(seen.waitedMs >= 20)
})

test('超时判据:静默的旧输出不算增长,尾部像提示符时命中 likelyInteractive', async () => {
  // 派发前就存在的输出保持不变——基线采样保证它不会在超时那一刻被误判成刚刚增长
  const handle = makePendingHandle(() => 'Enter passphrase for key: ')
  const { callModel } = scriptedModel([
    turnResponse('登录', [toolCall('c1', 'ssh host')])
  ])
  let seen
  const { deps } = makeDeps({
    callModel,
    startCommand: () => handle,
    requestTimeoutDecision: async (step, info) => {
      seen = info
      return 'stop'
    }
  })
  await runAgentTask('测试', deps, { commandTimeoutMs: 60, outputSampleIntervalMs: 5 }).done

  assert.equal(seen.outputGrowing, false, '长度未变即视为静默')
  assert.equal(seen.likelyInteractive, true)
  assert.ok(seen.silentMs >= 60, '静默时长从派发基线起算')
  assert.ok(seen.hint.includes('等待你的输入'))
  assert.ok(seen.hint.includes('不会终止终端里的命令'), '需附停止语义说明')
})

test('超时判据:静默且尾部不像提示符时给出"可能卡住"文案', async () => {
  const handle = makePendingHandle(() => 'building...\n')
  const { callModel } = scriptedModel([
    turnResponse('构建', [toolCall('c1', 'make')])
  ])
  let seen
  const { deps } = makeDeps({
    callModel,
    startCommand: () => handle,
    requestTimeoutDecision: async (step, info) => {
      seen = info
      return 'stop'
    }
  })
  await runAgentTask('测试', deps, { commandTimeoutMs: 60, outputSampleIntervalMs: 5 }).done

  assert.equal(seen.outputGrowing, false)
  assert.equal(seen.likelyInteractive, false, '以换行结尾不判为等待输入')
  assert.ok(seen.hint.includes('可能仍在运行或已卡住'))
  assert.ok(seen.hint.includes('不会终止终端里的命令'))
})

test('超时后停止:已捕获的部分输出保留在步骤上,只取尾部', async () => {
  const long = `${'a'.repeat(400)}TAIL${'b'.repeat(300)}`
  const handle = makePendingHandle(() => long)
  const { callModel } = scriptedModel([
    turnResponse('慢命令', [toolCall('c1', 'sleep 999')])
  ])
  let seen
  const { deps } = makeDeps({
    callModel,
    startCommand: () => handle,
    requestTimeoutDecision: async (step, info) => {
      seen = info
      return 'stop'
    }
  })
  const state = await runAgentTask('测试', deps, { commandTimeoutMs: 20, outputSampleIntervalMs: 5 }).done

  assert.equal(seen.partialOutput.length, 500, '超时提示只带尾部 500 字符')
  assert.ok(seen.partialOutput.endsWith('b'.repeat(300)), '保留的是尾部')
  // 回归:此前超时步骤的卡片上只剩一条命令,已捕获的内容白白丢掉
  assert.equal(state.steps[0].status, 'timeout')
  assert.equal(state.steps[0].output, seen.partialOutput)
  assert.equal(handle.cancelCalls, 1, '放弃等待但不终止命令')
})

test('peekOutput 抛错按"无新输出"处理,不中断循环', async () => {
  const handle = makePendingHandle(() => {
    throw new Error('捕获侧炸了')
  })
  const { callModel } = scriptedModel([
    turnResponse('慢命令', [toolCall('c1', 'sleep 999')])
  ])
  let seen
  const { deps } = makeDeps({
    callModel,
    startCommand: () => handle,
    requestTimeoutDecision: async (step, info) => {
      seen = info
      return 'stop'
    }
  })
  const state = await runAgentTask('测试', deps, { commandTimeoutMs: 40, outputSampleIntervalMs: 5 }).done

  assert.equal(state.status, 'stopped', '异常不应把任务打成 error')
  assert.equal(state.steps[0].status, 'timeout')
  assert.equal(seen.partialOutput, '')
  assert.equal(seen.outputGrowing, false)
  assert.equal(seen.likelyInteractive, false)
})

test('looksLikeInteractivePrompt:命中密码/确认/以提示符收尾的行', () => {
  for (const output of [
    'Password:',
    "root's password: ",
    'Enter passphrase for key:',
    '请输入密码：',
    'Overwrite existing file? [y/N]',
    'Continue? [Y/n]:',
    'Are you sure (yes/no)?',
    'Continue installation?',
    'sqlite> ',
    'Enter value:'
  ]) {
    assert.equal(looksLikeInteractivePrompt(output), true, `应命中:${JSON.stringify(output)}`)
  }
})

test('looksLikeInteractivePrompt:以换行结尾或普通输出不命中', () => {
  for (const output of [
    '',
    'total 48\n',
    // 关键前提:正常输出会换行,提示符停在行内不换行
    'Password:\n',
    'Overwrite? [y/N]\n  ',
    'drwxr-xr-x  5 me staff 160 Aug 30 10:00 src',
    'building the project',
    '\n'
  ]) {
    assert.equal(looksLikeInteractivePrompt(output), false, `不应命中:${JSON.stringify(output)}`)
  }
})

test('describeTimeoutHint:三个分支各自成文,停止语义只附在需要处', () => {
  const base = { waitedMs: 120_000, silentMs: 90_000, partialOutput: '', outputGrowing: false, likelyInteractive: false }
  const semantics = '不会终止终端里的命令'

  const growing = describeTimeoutHint({ ...base, outputGrowing: true })
  assert.ok(growing.includes('已运行 120s'), '等待时长按秒取整')
  assert.ok(growing.includes('仍在持续输出'))
  assert.ok(!growing.includes(semantics), '仍在输出时无需解释停止语义')

  const interactive = describeTimeoutHint({ ...base, likelyInteractive: true })
  assert.ok(interactive.includes('最近 90s 无新输出'))
  assert.ok(interactive.includes('等待你的输入'))
  assert.ok(interactive.includes('继续等待不会重启命令'))
  assert.ok(interactive.includes(semantics))

  const stuck = describeTimeoutHint(base)
  assert.ok(stuck.includes('最近 90s 无新输出'))
  assert.ok(stuck.includes('可能仍在运行或已卡住'))
  assert.ok(stuck.includes(semantics))
})
