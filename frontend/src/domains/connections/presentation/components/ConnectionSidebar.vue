<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ConnectionProfile } from '../../domain/profile'
import UiIcon from '../../../../shared/ui/UiIcon.vue'

const props = defineProps<{
  profiles: ConnectionProfile[]
  selectedProfileId: string
  selectedProfile?: ConnectionProfile
  connectingProfileId: string
  connectedProfileIds?: string[]
  pendingConnectionProfileIds?: string[]
  connectionError: string
  editorOpen: boolean
  editorMode: 'create' | 'edit'
  saveState: 'idle' | 'saving' | 'saved' | 'error'
  saveError: string
}>()

const emit = defineEmits<{
  select: [profileId: string]
  edit: [profileId: string]
  copy: [profileId: string]
  delete: [profileId: string]
  closeEditor: []
  connect: [profileId: string]
  create: []
  openMenu: [event: MouseEvent, profileId: string]
  save: []
}>()

const query = ref('')
const showTargetPassword = ref(false)
const targetPasswordInput = ref<HTMLInputElement>()

watch(
  () => [props.editorOpen, props.selectedProfile?.id] as const,
  () => {
    showTargetPassword.value = false
  }
)

function passwordFieldType(visible: boolean) {
  return visible ? 'text' : 'password'
}

function passwordToggleLabel(visible: boolean) {
  return visible ? '隐藏密码' : '显示密码'
}

function toggleTargetPassword() {
  const input = targetPasswordInput.value
  const selectionStart = input?.selectionStart ?? null
  const selectionEnd = input?.selectionEnd ?? null
  showTargetPassword.value = !showTargetPassword.value

  requestAnimationFrame(() => {
    input?.focus({ preventScroll: true })
    if (selectionStart !== null && selectionEnd !== null) {
      input?.setSelectionRange(selectionStart, selectionEnd)
    }
  })
}

const filteredProfiles = computed(() => {
  const value = query.value.trim().toLowerCase()
  if (!value) return props.profiles
  return props.profiles.filter((profile) => {
    return [profile.name, profile.gateway.host, profile.gateway.username, profile.target.host, profile.target.username]
      .join(' ')
      .toLowerCase()
      .includes(value)
  })
})


function targetUsernameLabel(_profile: ConnectionProfile) {
  return '登录用户名'
}

function targetUsernamePlaceholder(_profile: ConnectionProfile) {
  return '堡垒机用户名 或 堡垒机用户名/服务器IP/服务器用户名'
}

function connectionRoleLabel(profile: ConnectionProfile) {
  return profile.connectionRole === 'bastion' ? '堡垒机' : '直连'
}

function shouldShowTargetPassword(profile: ConnectionProfile) {
  return profile.target.authMode !== 'key'
}

function targetPasswordLabel(_profile: ConnectionProfile) {
  return 'SSH 密码'
}

function targetPortLabel(_profile: ConnectionProfile) {
  return 'SSH 端口'
}

function targetPasswordPlaceholder() {
  return '可选，保存后用于自动登录'
}

function profileReady(profile: ConnectionProfile) {
  return Boolean(profile.name.trim() && profile.target.host.trim() && profile.target.username.trim())
}

const selectedProfileReadyToSave = computed(() => {
  const profile = props.selectedProfile
  return profile ? profileReady(profile) : false
})

function profileReadyToConnect(profile: ConnectionProfile) {
  return profileReady(profile) && !isProfileConnecting(profile)
}

function isProfileConnecting(profile: ConnectionProfile) {
  return profile.id === props.connectingProfileId || props.pendingConnectionProfileIds?.includes(profile.id) === true
}

function isProfileConnected(profile: ConnectionProfile) {
  return props.connectedProfileIds?.includes(profile.id) === true
}

function connectionStatusLabel(profile: ConnectionProfile) {
  if (isProfileConnecting(profile)) {
    return isProfileConnected(profile) ? 'SSH 终端运行中，正在新建连接' : '连接中'
  }
  return isProfileConnected(profile) ? 'SSH 终端运行中' : ''
}

function connectButtonLabel(profile: ConnectionProfile) {
  if (isProfileConnecting(profile)) return '连接中'
  return isProfileConnected(profile) ? '新建终端连接' : '连接服务器'
}

function connectProfile(profile: ConnectionProfile, event?: MouseEvent) {
  if (event && event.detail > 1) return
  if (profileReadyToConnect(profile)) emit('connect', profile.id)
}
</script>

<template>
  <aside class="sidebar connection-sidebar">
    <div class="section-head">
      <span class="section-title">连接</span>
      <button class="connection-create-button" type="button" title="新建连接" aria-label="新建连接" @click="emit('create')">
        <UiIcon name="plus" />
        <span>新建</span>
      </button>
    </div>
    <div class="connection-search">
      <UiIcon name="search" />
      <input v-model="query" class="search-input" placeholder="搜索连接" aria-label="搜索名称、主机或用户" title="搜索名称、主机或用户" />
    </div>
    <div class="server-list">
      <p v-if="filteredProfiles.length === 0" class="empty-state">{{ query.trim() ? '未找到匹配的连接' : '暂无连接' }}</p>
      <article
        v-for="profile in filteredProfiles"
        :key="profile.id"
        class="server-card"
        :class="{ active: profile.id === selectedProfileId }"
        role="button"
        :aria-pressed="profile.id === selectedProfileId"
        tabindex="0"
        @click="emit('select', profile.id)"
        @dblclick="connectProfile(profile)"
        @contextmenu.prevent="emit('openMenu', $event, profile.id)"
        @keydown.enter.self.exact.prevent="emit('select', profile.id)"
        @keydown.space.self.exact.prevent="emit('select', profile.id)"
        @keydown.ctrl.enter.self.exact.prevent="connectProfile(profile)"
      >
        <div class="server-main">
          <div class="server-name">
            <span
              v-if="connectionStatusLabel(profile)"
              class="server-status"
              :class="{ connecting: isProfileConnecting(profile) }"
              role="img"
              :title="connectionStatusLabel(profile)"
              :aria-label="connectionStatusLabel(profile)"
            >
              <UiIcon :name="isProfileConnecting(profile) ? 'refresh' : 'check'" />
            </span>
            <strong :title="profile.name">{{ profile.name }}</strong>
          </div>
          <div class="card-actions" @dblclick.stop>
            <button class="icon-button connect" type="button" :title="connectButtonLabel(profile)" :aria-label="connectButtonLabel(profile)" :disabled="!profileReadyToConnect(profile)" @click.stop="connectProfile(profile, $event)">
              <UiIcon name="play" />
            </button>
            <button class="icon-button more" type="button" title="更多操作" aria-label="更多操作" @click.stop="emit('openMenu', $event, profile.id)">
              <UiIcon name="more" />
            </button>
          </div>
        </div>
        <div class="server-meta">
          <span class="server-address" :title="(profile.target.username || '用户') + '@' + (profile.target.host || '服务器')">{{ profile.target.username || '用户' }}@{{ profile.target.host || '服务器' }}</span>
          <span class="server-role">{{ connectionRoleLabel(profile) }}</span>
        </div>
      </article>
    </div>
    <teleport to="body">
      <div v-if="selectedProfile && editorOpen" class="modal-backdrop" role="presentation">
        <form class="modal profile-editor-modal" role="dialog" aria-modal="true" aria-label="连接配置" @submit.prevent>
          <div class="modal-head">
            <div>
              <strong>{{ editorMode === 'create' ? '新建连接' : '编辑连接' }}</strong>
              <span>连接信息和密码保存在本机。</span>
            </div>
            <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="emit('closeEditor')"><UiIcon name="close" /></button>
          </div>
          <div class="profile-editor" @submit.prevent>
            <p v-if="saveState === 'saved'" class="save-feedback ok">配置已保存</p>
            <p v-else-if="saveState === 'error'" class="save-feedback error">{{ saveError }}</p>
            <p v-if="connectionError" class="connection-error">{{ connectionError }}</p>
            <label class="wide">
              <span>连接名</span>
              <input v-model="selectedProfile.name" placeholder="prod-app-01" />
            </label>
            <label>
              <span>连接模式</span>
              <select v-model="selectedProfile.connectionRole">
                <option value="direct">直接主机</option>
                <option value="bastion">堡垒机</option>
              </select>
            </label>
            <label>
              <span>SSH 主机</span>
              <input v-model="selectedProfile.target.host" placeholder="ssh.company.com 或 10.0.0.12" />
            </label>
            <label>
              <span>{{ targetUsernameLabel(selectedProfile) }}</span>
              <input v-model="selectedProfile.target.username" :placeholder="targetUsernamePlaceholder(selectedProfile)" />
            </label>
            <label>
              <span>{{ targetPortLabel(selectedProfile) }}</span>
              <input v-model.number="selectedProfile.target.port" type="number" min="1" max="65535" step="1" placeholder="22" />
            </label>
            <label>
              <span>SSH 认证</span>
              <select v-model="selectedProfile.target.authMode">
                <option value="auto">auto</option>
                <option value="password">password</option>
                <option value="key">key</option>
              </select>
            </label>
            <label v-if="shouldShowTargetPassword(selectedProfile)">
              <span>{{ targetPasswordLabel(selectedProfile) }}</span>
              <div class="password-input-wrap">
                <input ref="targetPasswordInput" v-model="selectedProfile.target.password" :type="passwordFieldType(showTargetPassword)" autocomplete="off" :placeholder="targetPasswordPlaceholder()" />
                <button
                  class="icon-button password-visibility-button"
                  type="button"
                  :title="passwordToggleLabel(showTargetPassword)"
                  :aria-label="passwordToggleLabel(showTargetPassword)"
                  :aria-pressed="showTargetPassword"
                  @mousedown.prevent
                  @click="toggleTargetPassword"
                >
                  <UiIcon :name="showTargetPassword ? 'eye-off' : 'eye'" />
                </button>
              </div>
            </label>
          </div>
          <div class="modal-actions profile-editor-actions">
            <button type="button" @click="emit('closeEditor')">取消</button>
            <button class="profile-save-button" type="button" :disabled="!selectedProfileReadyToSave || saveState === 'saving'" @click="emit('save')">
              {{ saveState === 'saving' ? '保存中' : '保存配置' }}
            </button>
          </div>
        </form>
      </div>
    </teleport>
  </aside>
</template>
