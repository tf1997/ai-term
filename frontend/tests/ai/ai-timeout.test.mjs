import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAiTimeoutSeconds } from "../../src/domains/ai/domain/aiTimeout"

test('未设置、清空或输入 0 均表示不超时', () => {
  for (const value of [undefined, null, '', ' ', 0, '0']) {
    assert.equal(parseAiTimeoutSeconds(value), 0)
  }
})

test('超时按整数秒保存', () => {
  assert.equal(parseAiTimeoutSeconds(60), 60)
  assert.equal(parseAiTimeoutSeconds('120'), 120)
  assert.equal(parseAiTimeoutSeconds(' 30 '), 30)
  assert.equal(parseAiTimeoutSeconds(4_294_967_295), 4_294_967_295)
})

test('拒绝负数、小数、非数字与超出后端范围的值', () => {
  for (const value of [-1, '-30', 0.5, '1.5', 'abc', NaN, Infinity, true, {}, 4_294_967_296]) {
    assert.throws(() => parseAiTimeoutSeconds(value), /请求超时/)
  }
})
