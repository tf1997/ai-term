import assert from 'node:assert/strict'
import test from 'node:test'
import { createStableRefRegistry } from "../../src/domains/terminal/domain/stableRefRegistry"

test('同一终端在重复渲染时复用同一个 ref 回调', () => {
  const registry = createStableRefRegistry()
  const first = registry.refFor('terminal-1')
  const pane = { id: 'pane-1' }
  first(pane)

  assert.equal(registry.refFor('terminal-1'), first)
  assert.equal(registry.values['terminal-1'], pane)
})

test('真正卸载或关闭标签时移除终端实例', () => {
  const registry = createStableRefRegistry()
  const setter = registry.refFor('terminal-1')
  setter({ id: 'pane-1' })
  setter(null)
  assert.equal(registry.values['terminal-1'], undefined)

  const nextSetter = registry.refFor('terminal-1')
  nextSetter({ id: 'pane-2' })
  registry.remove('terminal-1')
  assert.equal(registry.values['terminal-1'], undefined)
  assert.notEqual(registry.refFor('terminal-1'), nextSetter)
})
