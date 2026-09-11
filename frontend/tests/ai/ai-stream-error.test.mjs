import assert from 'node:assert/strict'
import test from 'node:test'
import { aiStreamPartialText, createAiStreamErrorMessage } from "../../src/domains/ai/domain/aiStreamError"

const message = {
  id: 'assistant-1',
  connectionId: 'connection-1',
  workspaceSessionId: 'session-1',
  terminalId: 'terminal-1',
  role: 'assistant',
  text: '',
  command: 'journalctl -n 100 --no-pager',
  streaming: true,
  createdAt: '2026-09-07T00:00:00Z'
}

test('中途断流保留正文且不会生成可执行的兜底命令', () => {
  const partial = '已经收到的文字\n```sh\nrm -'
  const failed = createAiStreamErrorMessage(message, 'AI 流式响应读取中断', partial)
  assert.equal(failed.text, 'AI 流式响应读取中断')
  assert.equal(failed.error, true)
  assert.equal(failed.streaming, false)
  assert.equal(failed.command, '')
  assert.equal(aiStreamPartialText(failed), partial)
  assert.equal(aiStreamPartialText(JSON.parse(JSON.stringify(failed))), partial)
  assert.equal(message.streaming, true)
})

test('错误事件和请求拒绝重复更新不会丢失已收到内容', () => {
  const first = createAiStreamErrorMessage(message, '断流', '部分正文')
  const final = createAiStreamErrorMessage(first, '断流: connection reset', '部分正文')
  assert.equal(aiStreamPartialText(final), '部分正文')
  assert.equal(final.text, '断流: connection reset')
})

test('重试后不显示旧的部分正文', () => {
  const failed = createAiStreamErrorMessage(message, '断流', '上次的部分正文')
  assert.equal(aiStreamPartialText({ ...failed, error: false }), '')
  const retried = createAiStreamErrorMessage(failed, '超时', '')
  assert.equal(aiStreamPartialText(retried), '')
  assert.equal(retried.payloadJson, undefined)
})

test('Agent 错误保留任务步骤与中断文本', () => {
  const payload = { mode: 'agent', agentStatus: 'error', agentSteps: [{ id: 'step-1' }] }
  const failed = createAiStreamErrorMessage({ ...message, payloadJson: JSON.stringify(payload) }, '断流', '正在分析')
  assert.deepEqual(JSON.parse(failed.payloadJson), { ...payload, partialText: '正在分析' })
})

test('旧消息和异常载荷不会破坏错误展示', () => {
  for (const payloadJson of [undefined, '{broken', 'null', '[]', '{"partialText":123}']) {
    assert.equal(aiStreamPartialText({ ...message, error: true, payloadJson }), '')
    const failed = createAiStreamErrorMessage({ ...message, payloadJson }, '断流', '正文')
    assert.equal(aiStreamPartialText(failed), '正文')
  }
})
