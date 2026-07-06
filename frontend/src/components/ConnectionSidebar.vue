<script setup lang="ts">
import { computed, ref } from 'vue'
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

function isSftpProfile(profile: ConnectionProfile) {
  return profile.fileTransferMode === 'sftp-direct' || profile.fileTransferMode === 'sftp-gateway'
}

function needsGateway(profile: ConnectionProfile) {
  return profile.jumpMode === 'interactive-menu' || profile.fileTransferMode === 'sftp-gateway'
}

function needsMenuProfile(profile: ConnectionProfile) {
  return profile.jumpMode === 'interactive-menu' && !isSftpProfile(profile)
}

function targetUsernameRequired(profile: ConnectionProfile) {
  return !(profile.jumpMode === 'interactive-menu' && !isSftpProfile(profile))
}

function targetUsernameLabel(profile: ConnectionProfile) {
  return targetUsernameRequired(profile) ? '目标用户名' : '目标用户名（可选）'
}

function targetUsernamePlaceholder(profile: ConnectionProfile) {
  return targetUsernameRequired(profile) ? 'deploy' : '可选，有些堡垒机会直接进入'
}
function shouldShowTargetPassword(profile: ConnectionProfile) {
  return profile.target.authMode !== 'key'
}

function targetPasswordLabel(profile: ConnectionProfile) {
  return profile.jumpMode === 'interactive-menu' ? '\u670d\u52a1\u5668\u5bc6\u7801\uff08\u53ef\u9009\uff09' : '\u670d\u52a1\u5668\u5bc6\u7801'
}

function gatewayPortLabel() {
  return '\u5821\u5792\u673a\u7aef\u53e3'
}

function targetPortLabel(profile: ConnectionProfile) {
  return isSftpProfile(profile) ? 'SFTP 端口' : 'SSH 端口'
}

function targetPasswordPlaceholder() {
  return '\u53ef\u9009\uff0c\u7528\u4e8e\u76ee\u6807\u670d\u52a1\u5668\u81ea\u52a8\u767b\u5f55'
}
function profileReady(profile: ConnectionProfile) {
  const hasTarget = Boolean(
    profile.name.trim() &&
      profile.target.host.trim() &&
      (!targetUsernameRequired(profile) || profile.target.username.trim())
  )
  if (!hasTarget) return false
  if (!needsGateway(profile)) return true
  const hasGateway = Boolean(profile.gateway.host.trim() && profile.gateway.username.trim())
  if (!hasGateway) return false
  if (needsMenuProfile(profile)) return Boolean(profile.menuProfileId.trim())
  return true
}

const selectedProfileReadyToSave = computed(() => {
  const profile = props.selectedProfile
  return profile ? profileReady(profile) : false
})

function profileReadyToConnect(profile: ConnectionProfile) {
  return profileReady(profile)
}

function setConnectionEditorType(kind: 'ssh' | 'sftp') {
  const profile = props.selectedProfile
  if (!profile) return
  if (kind === 'ssh') {
    profile.fileTransferMode = 'auto'
    return
  }
  profile.fileTransferMode = profile.jumpMode === 'interactive-menu' ? 'sftp-gateway' : 'sftp-direct'
  if (profile.jumpMode === 'interactive-menu') {
    profile.menuProfileId = ''
  }
}

function setSftpRoute(route: 'sftp-direct' | 'sftp-gateway') {
  const profile = props.selectedProfile
  if (!profile) return
  profile.fileTransferMode = route
  profile.jumpMode = route === 'sftp-gateway' ? 'interactive-menu' : 'direct'
  if (route === 'sftp-gateway') {
    profile.menuProfileId = ''
  }
}

function handleJumpModeChanged() {
  const profile = props.selectedProfile
  if (!profile || !isSftpProfile(profile)) return
  profile.fileTransferMode = profile.jumpMode === 'interactive-menu' ? 'sftp-gateway' : 'sftp-direct'
  if (profile.fileTransferMode === 'sftp-gateway') {
    profile.menuProfileId = ''
  }
}
</script>

<template>
  <aside class="sidebar">
    <div class="section-head">
      <span class="section-title">连接管理</span>
      <button class="primary" type="button" title="新建连接" aria-label="新建连接" @click="emit('create')">
        <UiIcon name="plus" />
        <span>新建连接</span>
      </button>
    </div>
    <input v-model="query" class="search-input" placeholder="搜索连接..." aria-label="搜索连接" />
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
              :class="{ ok: profile.jumpMode === 'direct' && !isSftpProfile(profile), warn: profile.jumpMode === 'interactive-menu' || profile.id === connectingProfileId, sftp: isSftpProfile(profile) }"
            >
              {{ profile.id === connectingProfileId ? '连接中' : isSftpProfile(profile) ? 'SFTP' : profile.jumpMode === 'direct' ? '直连' : '堡垒机' }}
            </span>
          </div>
          <div class="server-meta">
            <span>{{ profile.target.username || '用户' }}@{{ profile.target.host || '服务器' }}</span>
            <span>
              {{ isSftpProfile(profile) ? (profile.fileTransferMode === 'sftp-gateway' ? 'SFTP 经网关' : 'SFTP 直连') : profile.jumpMode === 'interactive-menu' ? `菜单 ${profile.menuProfileId || '-'}` : 'SSH / SFTP' }}
            </span>
          </div>
        </div>
        <div class="card-actions">
          <button class="icon-button" type="button" :title="isSftpProfile(profile) ? '打开 SFTP' : '连接服务器'" :aria-label="isSftpProfile(profile) ? '打开 SFTP' : '连接服务器'" :disabled="!profileReadyToConnect(profile) || profile.id === connectingProfileId" @click.stop="emit('connect', profile.id)">
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
              <span>保存后写入 SQLite，连接列表会自动刷新。</span>
            </div>
            <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="emit('closeEditor')"><UiIcon name="close" /></button>
          </div>
          <div class="modal-actions">
            <button type="button" @click="emit('closeEditor')">取消</button>
            <button type="button" :disabled="!selectedProfileReadyToSave || saveState === 'saving'" @click="emit('save')">
              {{ saveState === 'saving' ? '保存中' : '保存配置' }}
            </button>
          </div>
          <div class="profile-editor" @submit.prevent>
            <div class="editor-mode-tabs" aria-label="Connection type tabs">
              <button type="button" :class="{ active: !isSftpProfile(selectedProfile) }" @click="setConnectionEditorType('ssh')">SSH 连接</button>
              <button type="button" :class="{ active: isSftpProfile(selectedProfile) }" @click="setConnectionEditorType('sftp')">SFTP 连接</button>
            </div>
            <p v-if="saveState === 'saved'" class="save-feedback ok">配置已保存</p>
            <p v-else-if="saveState === 'error'" class="save-feedback error">{{ saveError }}</p>
            <p v-if="connectionError" class="connection-error">{{ connectionError }}</p>
            <label class="wide">
              <span>连接名</span>
              <input v-model="selectedProfile.name" placeholder="prod-app-01" />
            </label>
            <label class="wide">
              <span>连接方式</span>
              <select v-model="selectedProfile.jumpMode" @change="handleJumpModeChanged">
                <option value="direct">{{ isSftpProfile(selectedProfile) ? 'SFTP 直连' : '普通直连' }}</option>
                <option value="interactive-menu">{{ isSftpProfile(selectedProfile) ? 'SFTP 网关' : '堡垒机菜单' }}</option>
              </select>
            </label>
            <label v-if="isSftpProfile(selectedProfile)" class="wide">
              <span>SFTP 路由</span>
              <select :value="selectedProfile.fileTransferMode" @change="setSftpRoute(($event.target as HTMLSelectElement).value as 'sftp-direct' | 'sftp-gateway')">
                <option value="sftp-direct">直连目标服务器</option>
                <option value="sftp-gateway">通过网关 ProxyJump</option>
              </select>
            </label>
            <label v-if="needsGateway(selectedProfile)">
              <span>入口域名</span>
              <input v-model="selectedProfile.gateway.host" placeholder="ssh.company.com" />
            </label>
            <label v-if="needsGateway(selectedProfile)">
              <span>个人用户名</span>
              <input v-model="selectedProfile.gateway.username" placeholder="company.user" />
            </label>
            <label v-if="needsGateway(selectedProfile)">
              <span>{{ gatewayPortLabel() }}</span>
              <input v-model.number="selectedProfile.gateway.port" type="number" min="1" max="65535" step="1" placeholder="22" />
            </label>
            <label>
              <span>目标主机</span>
              <input v-model="selectedProfile.target.host" placeholder="10.0.0.12" />
            </label>
            <label>
              <span>{{ targetUsernameLabel(selectedProfile) }}</span>
              <input v-model="selectedProfile.target.username" :placeholder="targetUsernamePlaceholder(selectedProfile)" />
            </label>
            <label>
              <span>{{ targetPortLabel(selectedProfile) }}</span>
              <input v-model.number="selectedProfile.target.port" type="number" min="1" max="65535" step="1" placeholder="22" />
            </label>
            <label v-if="needsMenuProfile(selectedProfile)">
              <span>菜单配置</span>
              <input v-model="selectedProfile.menuProfileId" placeholder="company-default" />
            </label>
            <label v-if="needsGateway(selectedProfile)">
              <span>堡垒机认证</span>
              <select v-model="selectedProfile.gateway.authMode">
                <option value="auto">auto</option>
                <option value="password">password</option>
                <option value="key">key</option>
              </select>
            </label>
            <label v-if="needsGateway(selectedProfile) && selectedProfile.gateway.authMode !== 'key'">
              <span>堡垒机密码</span>
              <input v-model="selectedProfile.gateway.password" type="password" autocomplete="off" placeholder="明文保存，用于自动登录" />
            </label>
            <label>
              <span>{{ isSftpProfile(selectedProfile) ? 'SFTP 认证' : '目标认证' }}</span>
              <select v-model="selectedProfile.target.authMode">
                <option value="auto">auto</option>
                <option value="password">password</option>
                <option value="key">key</option>
              </select>
            </label>
            <label v-if="shouldShowTargetPassword(selectedProfile)">
              <span>{{ targetPasswordLabel(selectedProfile) }}</span>
              <input v-model="selectedProfile.target.password" type="password" autocomplete="off" :placeholder="targetPasswordPlaceholder()" />
            </label>
          </div>
        </form>
      </div>
    </teleport>
  </aside>
</template>
