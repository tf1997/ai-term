import assert from 'node:assert/strict'
import test from 'node:test'

import { describeAiError, hasExtraErrorDetail } from '../src/lib/aiErrorPresentation.ts'

test('HTTP 5xx 归类为服务端不可用且可重试', () => {
  const view = describeAiError('模型请求失败：HTTP 502\n模型未返回错误正文')
  assert.equal(view.title, '模型服务暂时不可用')
  assert.equal(view.code, 'HTTP 502')
  assert.equal(view.retryable, true)
  assert.match(view.hint, /稍后重试/)
  // 原文两行都要留在折叠区里,不能只剩首行
  assert.equal(view.detail, '模型请求失败：HTTP 502\n模型未返回错误正文')
  assert.equal(hasExtraErrorDetail(view), true)

  assert.equal(describeAiError('模型请求失败：HTTP 500').title, '模型服务暂时不可用')
  assert.equal(describeAiError('模型请求失败：HTTP 503').code, 'HTTP 503')
})

test('鉴权与地址类错误不建议直接重试', () => {
  const unauthorized = describeAiError('模型请求失败：HTTP 401\nInvalid API key')
  assert.equal(unauthorized.title, '鉴权失败，API Key 无效或无权限')
  assert.equal(unauthorized.retryable, false)

  assert.equal(describeAiError('模型请求失败：HTTP 403').retryable, false)

  const notFound = describeAiError('模型请求失败：HTTP 404\nmodel not found')
  assert.equal(notFound.title, '接口地址或模型不存在')
  assert.equal(notFound.retryable, false)

  const badRequest = describeAiError('模型请求失败：HTTP 400\nunsupported model')
  assert.equal(badRequest.title, '请求被模型拒绝')
  assert.equal(badRequest.retryable, false)
  assert.equal(describeAiError('模型请求失败：HTTP 422').title, '请求被模型拒绝')

  // 其它未单独归类的 4xx 走通用分支,同样不鼓励盲目重试
  const teapot = describeAiError('模型请求失败：HTTP 418\nI am a teapot')
  assert.equal(teapot.title, '请求未被接受')
  assert.equal(teapot.code, 'HTTP 418')
  assert.equal(teapot.retryable, false)
})

test('限流与超时可重试', () => {
  const limited = describeAiError('模型请求失败：HTTP 429\nrate limit exceeded')
  assert.equal(limited.title, '请求过于频繁，已被限流')
  assert.equal(limited.retryable, true)

  assert.equal(describeAiError('模型请求失败：HTTP 504').title, '请求超时')
  assert.equal(describeAiError('模型请求失败：HTTP 408').title, '请求超时')

  const noStatus = describeAiError('AI 流式网络请求失败：https://example.com/v1\noperation timed out')
  assert.equal(noStatus.title, '请求超时')
  assert.equal(noStatus.code, '超时')
  assert.equal(noStatus.retryable, true)
})

test('网络不可达归类到网络', () => {
  const view = describeAiError('AI 网络请求失败：https://example.com/v1\nconnection refused')
  assert.equal(view.title, '网络无法访问模型服务')
  assert.equal(view.code, '网络')
  assert.equal(view.retryable, true)
})

test('配置缺失优先于 HTTP 归类', () => {
  for (const raw of ['请先配置 AI Base URL', '请先配置 AI Model', '请在 AI 配置中填写 API Key 并保存']) {
    const view = describeAiError(raw)
    assert.equal(view.title, 'AI 配置不完整')
    assert.equal(view.code, '配置')
    assert.equal(view.retryable, false)
  }
})

test('HTML 页面与本地后端不可用各自成类', () => {
  const html = describeAiError(
    'AI 接口返回了 HTML 页面，页面标题：登录，这通常表示 Base URL 填成了网页入口、网关登录页或接口路径不正确。\n当前请求地址：https://example.com'
  )
  assert.equal(html.title, '接口返回了网页而不是模型响应')
  assert.equal(html.retryable, false)
  // 后端自带的长建议必须原样留在详情里
  assert.match(html.detail, /当前请求地址/)

  const ipc = describeAiError('AI 后端调用不可用：__TAURI_IPC__ is not defined\n请通过 Tauri 客户端运行，或在 src-tauri 目录执行 cargo run。')
  assert.equal(ipc.title, '本地后端不可用')
  assert.equal(ipc.retryable, false)
})

test('空响应可重试', () => {
  const view = describeAiError('模型返回为空')
  assert.equal(view.title, '模型没有返回内容')
  assert.equal(view.retryable, true)
  // 标题是归类结论,与原文不同,折叠区仍然有信息量
  assert.equal(hasExtraErrorDetail(view), true)
})

test('剥离历史消息里的装饰前缀与本地建议尾巴', () => {
  const agent = describeAiError('任务出错：模型请求失败：HTTP 502\n模型未返回错误正文')
  assert.equal(agent.detail, '模型请求失败：HTTP 502\n模型未返回错误正文')
  assert.equal(agent.title, '模型服务暂时不可用')

  const stream = describeAiError('模型流式调用失败。\n\n错误详情：模型请求失败：HTTP 429')
  assert.equal(stream.detail, '模型请求失败：HTTP 429')
  assert.equal(stream.title, '请求过于频繁，已被限流')

  const legacyCatch = describeAiError(
    '模型调用失败，未执行任何远程请求结果。\n\n错误详情：AI 网络请求失败：https://example.com/v1\n\n可临时参考本地建议：df -h'
  )
  assert.equal(legacyCatch.detail, 'AI 网络请求失败：https://example.com/v1')
  assert.equal(legacyCatch.title, '网络无法访问模型服务')
})

test('无法归类时用首行兜底并截断', () => {
  const short = describeAiError('  something went sideways  \n\nsecond line')
  assert.equal(short.title, 'something went sideways')
  assert.equal(short.code, '')
  assert.equal(short.hint, '')
  assert.equal(short.retryable, true)
  // 详情只做首尾去空白,原文内部保持逐字不变
  assert.equal(short.detail, 'something went sideways  \n\nsecond line')

  const long = describeAiError('x'.repeat(200))
  assert.equal(long.title.length, 61, '截断到 60 字符再加省略号')
  assert.ok(long.title.endsWith('…'))
  assert.equal(long.detail.length, 200, '详情保留完整原文')
})

test('空输入也返回可渲染结构', () => {
  const view = describeAiError('')
  assert.equal(view.title, '模型请求失败')
  assert.equal(view.detail, '')
  assert.equal(view.retryable, true)
  assert.equal(hasExtraErrorDetail(view), false, '没有原文时不展示折叠区')
})

test('CRLF 原文按 LF 归一', () => {
  const view = describeAiError('模型请求失败：HTTP 502\r\n模型未返回错误正文')
  assert.equal(view.detail, '模型请求失败：HTTP 502\n模型未返回错误正文')
})
