<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ConnectionProfile } from '../types/profile'
import UiIcon from './UiIcon.vue'

const props = defineProps<{
  profiles: ConnectionProfile[]
  selectedProfileId: string
  selectedProfile?: ConnectionProfile
  connectingProfileId: string
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
  return '可选，保存到系统凭据管理器用于自动登录'
}

function profileReady(profile: ConnectionProfile) {
  return Boolean(profile.name.trim() && profile.target.host.trim() && profile.target.username.trim())
}

const selectedProfileReadyToSave = computed(() => {
  const profile = props.selectedProfile
  return profile ? profileReady(profile) : false
})

function profileReadyToConnect(profile: ConnectionProfile) {
  return profileReady(profile)
}
</script>

<template>
  <aside class="sidebar">
    <div class="section-head">
      <span class="section-title">连接</span>
      <button class="primary" type="button" title="新建连接" aria-label="新建连接" @click="emit('create')">
        <UiIcon name="plus" />
        <span>新建</span>
      </button>
    </div>
    <input v-model="query" class="search-input" placeholder="搜索主机、用户或标签" aria-label="搜索连接" />
    <div class="server-list">
      <p v-if="filteredProfiles.length === 0" class="empty-state">暂无连接</p>
      <article
        v-for="profile in filteredProfiles"
        :key="profile.id"
        class="server-card"
        :class="{ active: profile.id === selectedProfileId }"
        role="button"
        tabindex="0"
        @click="emit('select', profile.id)"
        @dblclick="emit('connect', profile.id)"
        @contextmenu.prevent="emit('openMenu', $event, profile.id)"
        @keydown.enter="emit('select', profile.id)"
        @keydown.ctrl.enter="emit('connect', profile.id)"
      >
        <div class="server-content">
          <div class="server-main">
            <strong>{{ profile.name }}</strong>
            <span
              class="badge"
              :class="{ ok: profile.id !== connectingProfileId, warn: profile.id === connectingProfileId }"
            >
              {{ profile.id === connectingProfileId ? '连接中' : connectionRoleLabel(profile) }}
            </span>
          </div>
          <div class="server-meta">
            <span>{{ profile.target.username || '用户' }}@{{ profile.target.host || '服务器' }}</span>
            <span>
              SSH / SFTP
            </span>
          </div>
        </div>
        <div class="card-actions">
          <button class="icon-button" type="button" title="连接服务器" aria-label="连接服务器" :disabled="!profileReadyToConnect(profile) || profile.id === connectingProfileId" @click.stop="emit('connect', profile.id)">
            <UiIcon name="play" />
          </button>
          <button class="icon-button" type="button" title="更多操作" aria-label="更多操作" @click.stop="emit('openMenu', $event, profile.id)">
            <UiIcon name="more" />
          </button>
        </div>
      </article>
    </div>
    <teleport to="body">
      <div v-if="selectedProfile && editorOpen" class="modal-backdrop" role="presentation">
        <form class="modal profile-editor-modal" role="dialog" aria-modal="true" aria-label="连接配置" @submit.prevent>
          <div class="modal-head">
            <div>
              <strong>{{ editorMode === 'create' ? '新建连接' : '编辑连接' }}</strong>
              <span>连接信息写入 SQLite，密码保存到系统凭据管理器。</span>
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
