import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'
import { useConnectionProfiles } from "../../src/domains/connections/application/useConnectionProfiles"
import { useAiConfigs } from "../../src/domains/ai/application/useAiConfigs"
import { defaultAiConfig } from "../../src/domains/ai/model/providerConfig"
import { normalizeConnectionProfileForSave } from "../../src/domains/connections/model/profileConfig"

function profile(id = 'host') {
  return { id, name: id, connectionRole: 'direct', gateway: { host: '', port: 22, username: '', authMode: 'auto' }, target: { host: ' host ', port: 22, username: ' root ', authMode: 'auto', credentialRef: 'keychain:host' }, jumpMode: 'direct', menuProfileId: '', fileTransferMode: 'auto' }
}
function config(id) { return { ...defaultAiConfig, id, baseUrl: 'https://example.invalid', model: 'test', apiKey: 'test-key' } }
function fixture(initialProfiles = [profile()], initialConfigs = [config('one'), config('two')]) {
  let profiles = structuredClone(initialProfiles)
  let configs = structuredClone(initialConfigs)
  const notifications = [], panels = []
  const storage = {
    async listConnectionProfiles() { return structuredClone(profiles) },
    async saveConnectionProfile(value) { profiles = [...profiles.filter(row => row.id !== value.id), structuredClone(value)] },
    async deleteConnectionProfile(id) { profiles = profiles.filter(row => row.id !== id) },
    async listAiProviderConfigs() { return structuredClone(configs) },
    async saveAiProviderConfig(value) { configs = [...configs.filter(row => row.id !== value.id), structuredClone(value)] },
    async deleteAiProviderConfig(id) { configs = configs.filter(row => row.id !== id) }
  }
  const options = { showToast: (...args) => notifications.push(args), confirm: () => true }
  const connections = useConnectionProfiles({ ...options, openConnectionsPanel: () => panels.push('connections') }, storage)
  const ai = useAiConfigs({ ...options, profileStoreStatus: connections.profileStoreStatus, openSettingsPanel: () => panels.push('settings') }, storage)
  return { connections, ai, storage, notifications, panels }
}

test('连接草稿与已保存对象隔离，复制清除凭据引用且避免 ID 冲突', async () => {
  const { connections, panels } = fixture([profile(), profile('host-copy')])
  await connections.loadProfiles()
  connections.editSelectedProfile('host')
  connections.connectionDraft.value.target.host = 'changed'
  assert.equal(connections.profiles.value[0].target.host, ' host ')
  connections.copySelectedProfile('host')
  assert.equal(connections.connectionDraft.value.id, 'host-copy-2')
  assert.equal(connections.connectionDraft.value.target.credentialRef, undefined)
  assert.equal(connections.connectionDraft.value.gateway.credentialRef, undefined)
  assert.equal(connections.selectedProfileId.value, '')
  assert.equal(connections.connectionEditorMode.value, 'create')
  assert.deepEqual(panels, ['connections', 'connections'])
})

test('连接保存校验端口，规范化不修改原对象或丢失现有凭据引用', () => {
  const draft = profile()
  draft.target.password = '  '
  const normalized = normalizeConnectionProfileForSave(draft)
  assert.equal(normalized.target.host, 'host')
  assert.equal(normalized.target.username, 'root')
  assert.equal(normalized.target.credentialRef, 'keychain:host')
  assert.equal(normalized.target.password, undefined)
  assert.equal(draft.target.host, ' host ')
  for (const port of [0, 65536, 1.5, 'invalid']) assert.throws(() => normalizeConnectionProfileForSave({ ...draft, target: { ...draft.target, port } }), /65535/)
  assert.equal(normalizeConnectionProfileForSave({ ...draft, target: { ...draft.target, port: '' } }).target.port, 22)
})

test('连接保存成功刷新列表并关闭编辑器，失败保留草稿与错误提示', async () => {
  const { connections, storage, notifications } = fixture()
  await connections.loadProfiles()
  connections.editSelectedProfile('host')
  await connections.saveSelectedProfile()
  assert.equal(connections.connectionEditorOpen.value, false)
  assert.equal(connections.connectionSaveState.value, 'saved')
  storage.saveConnectionProfile = async () => { throw Error('unavailable') }
  const failing = useConnectionProfiles({ openConnectionsPanel() {}, showToast: (...args) => notifications.push(args) }, storage)
  failing.createProfile()
  await failing.saveSelectedProfile()
  assert.equal(failing.connectionEditorOpen.value, true)
  assert.equal(failing.connectionSaveState.value, 'error')
  assert.equal(failing.connectionSaveError.value, 'unavailable')
  assert.equal(notifications.at(-1)[0], 'error')
})

test('连接加载失败进入预览，取消删除不调用存储', async () => {
  let deleted = false
  const state = useConnectionProfiles({ openConnectionsPanel() {}, showToast() {}, confirm: () => false }, {
    async listConnectionProfiles() { throw Error('browser') }, async saveConnectionProfile() {}, async deleteConnectionProfile() { deleted = true }
  })
  await state.loadProfiles()
  await state.deleteSelectedProfile('host')
  assert.equal(state.profileStoreStatus.value, 'preview')
  assert.equal(deleted, false)
})

test('编辑或取消 AI 草稿不改变当前使用配置，编辑保存也保持原启用项', async () => {
  const { ai } = fixture()
  await ai.loadAiConfig()
  ai.selectAiConfig('one')
  ai.editAiConfig('two')
  ai.aiConfigDraft.value.model = 'updated'
  assert.equal(ai.selectedAiConfigId.value, 'one')
  assert.equal(ai.aiConfigs.value.find(row => row.id === 'two').model, 'test')
  await ai.saveAiConfig(ai.aiConfigDraft.value)
  assert.equal(ai.selectedAiConfigId.value, 'one')
  assert.equal(ai.aiConfigs.value.find(row => row.id === 'two').model, 'updated')
  ai.editAiConfig('two')
  ai.closeAiConfigEditor()
  assert.equal(ai.selectedAiConfigId.value, 'one')
  assert.equal(ai.aiConfigDraft.value, undefined)
})

test('新建 AI 配置保存后启用，运行时密钥按配置隔离，删除清除对应密钥', async () => {
  const { ai } = fixture()
  await ai.loadAiConfig()
  ai.createAiConfig()
  const draft = { ...ai.aiConfigDraft.value, baseUrl: 'https://example.invalid', model: 'new' }
  await ai.saveAiConfig(draft, 'new-key')
  assert.equal(ai.selectedAiConfigId.value, draft.id)
  assert.equal(ai.activeAiRuntimeApiKey.value, 'new-key')
  assert.equal(ai.aiConfig.value.apiKeyRef, 'ai-provider:' + draft.id)
  ai.selectAiConfig('one')
  assert.equal(ai.activeAiRuntimeApiKey.value, '')
  await ai.deleteSelectedAiConfig(draft.id)
  assert.equal(ai.aiRuntimeApiKeys.value[draft.id], undefined)
})

test('AI 配置加载优先选择可用配置，空列表与加载失败恢复默认', async () => {
  const { ai } = fixture([], [{ ...defaultAiConfig }, config('usable')])
  await ai.loadAiConfig()
  assert.equal(ai.selectedAiConfigId.value, 'usable')
  for (const listAiProviderConfigs of [async () => [], async () => { throw Error('browser') }]) {
    const fallback = useAiConfigs({ profileStoreStatus: ref('ready'), openSettingsPanel() {}, showToast() {} }, { listAiProviderConfigs, async saveAiProviderConfig() {}, async deleteAiProviderConfig() {} })
    await fallback.loadAiConfig()
    assert.equal(fallback.aiConfig.value.id, 'default')
  }
})

test('AI 保存失败保留编辑草稿和当前启用项', async () => {
  const state = useAiConfigs({ profileStoreStatus: ref('ready'), openSettingsPanel() {}, showToast() {} }, {
    async listAiProviderConfigs() { return [config('one'), config('two')] }, async saveAiProviderConfig() { throw Error('denied') }, async deleteAiProviderConfig() {}
  })
  await state.loadAiConfig()
  state.editAiConfig('two')
  await state.saveAiConfig(state.aiConfigDraft.value)
  assert.equal(state.selectedAiConfigId.value, 'one')
  assert.equal(state.aiConfigEditorOpen.value, true)
  assert.equal(state.aiConfigSaveState.value, 'error')
  assert.equal(state.aiConfigSaveError.value, 'denied')
})
