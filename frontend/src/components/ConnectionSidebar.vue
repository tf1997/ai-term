<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ConnectionProfile } from '../types/profile'

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

const selectedProfileReadyToSave = computed(() => {
  const profile = props.selectedProfile
  if (!profile) return false

  const hasTarget = Boolean(profile.name.trim() && profile.target.host.trim() && profile.target.username.trim())
  if (profile.jumpMode === 'direct') return hasTarget

  return Boolean(
    hasTarget &&
      profile.gateway.host.trim() &&
      profile.gateway.username.trim() &&
      profile.menuProfileId.trim()
  )
})

function profileReadyToConnect(profile: ConnectionProfile) {
  const hasTarget = Boolean(profile.name.trim() && profile.target.host.trim() && profile.target.username.trim())
  if (profile.jumpMode === 'direct') return hasTarget

  return Boolean(
    hasTarget &&
      profile.gateway.host.trim() &&
      profile.gateway.username.trim() &&
      profile.menuProfileId.trim()
  )
}
</script>

<template>
  <aside class="sidebar">
    <div class="section-head">
      <span class="section-title">连接管理</span>
      <button class="primary" title="Add connection" @click="emit('create')">+ 新建连接</button>
    </div>
    <input v-model="query" class="search-input" placeholder="搜索连接..." aria-label="Search connections" />
    <div class="server-list">
      <p v-if="filteredProfiles.length === 0" class="empty-state">No connections</p>
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
              :class="{ ok: profile.jumpMode === 'direct', warn: profile.jumpMode === 'interactive-menu' || profile.id === connectingProfileId }"
            >
              {{ profile.id === connectingProfileId ? '连接中' : profile.jumpMode === 'direct' ? '直连' : '堡垒机' }}
            </span>
          </div>
          <div class="server-meta">
            <span>{{ profile.target.username || 'user' }}@{{ profile.target.host || 'server' }}</span>
            <span>{{ profile.jumpMode === 'interactive-menu' ? `菜单 ${profile.menuProfileId || '-'}` : 'SSH / SFTP' }}</span>
          </div>
        </div>
        <div class="card-actions">
          <button class="icon-button" type="button" title="连接服务器" aria-label="连接服务器" :disabled="!profileReadyToConnect(profile) || profile.id === connectingProfileId" @click.stop="emit('connect', profile.id)">▶</button>
          <button class="icon-button" type="button" title="编辑连接" aria-label="编辑连接" @click.stop="emit('edit', profile.id)">✎</button>
          <button class="icon-button danger" type="button" title="删除连接" aria-label="删除连接" @click.stop="emit('delete', profile.id)">⌫</button>
        </div>
      </article>
    </div>
    <teleport to="body">
      <div v-if="selectedProfile && editorOpen" class="modal-backdrop" role="presentation" @click.self="emit('closeEditor')">
        <form class="modal profile-editor-modal" role="dialog" aria-modal="true" aria-label="连接配置" @submit.prevent>
          <div class="modal-head">
            <div>
              <strong>{{ editorMode === 'create' ? '新建连接' : '编辑连接' }}</strong>
              <span>保存后写入 SQLite，连接列表会自动刷新。</span>
            </div>
            <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="emit('closeEditor')">×</button>
          </div>
          <div class="modal-actions">
            <button type="button" @click="emit('closeEditor')">取消</button>
            <button type="button" :disabled="!selectedProfileReadyToSave || saveState === 'saving'" @click="emit('save')">
              {{ saveState === 'saving' ? '保存中' : '保存配置' }}
            </button>
          </div>
          <div class="profile-editor" @submit.prevent>
            <div class="editor-mode-tabs" aria-label="Connection type tabs">
              <button type="button" class="active">SSH 连接</button>
              <button type="button">SFTP 连接</button>
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
              <select v-model="selectedProfile.jumpMode">
                <option value="direct">普通直连</option>
                <option value="interactive-menu">堡垒机菜单</option>
              </select>
            </label>
            <label v-if="selectedProfile.jumpMode === 'interactive-menu'">
              <span>入口域名</span>
              <input v-model="selectedProfile.gateway.host" placeholder="ssh.company.com" />
            </label>
            <label v-if="selectedProfile.jumpMode === 'interactive-menu'">
              <span>个人用户名</span>
              <input v-model="selectedProfile.gateway.username" placeholder="company.user" />
            </label>
            <label>
              <span>服务器 IP</span>
              <input v-model="selectedProfile.target.host" placeholder="10.12.8.21 or server.company.internal" />
            </label>
            <label>
              <span>服务器用户名</span>
              <input v-model="selectedProfile.target.username" placeholder="app" />
            </label>
            <label v-if="selectedProfile.jumpMode === 'interactive-menu'">
              <span>菜单配置</span>
              <input v-model="selectedProfile.menuProfileId" placeholder="company-default" />
            </label>
            <label v-if="selectedProfile.jumpMode === 'interactive-menu'">
              <span>堡垒机认证</span>
              <select v-model="selectedProfile.gateway.authMode">
                <option value="auto">auto</option>
                <option value="password">password</option>
                <option value="key">key</option>
              </select>
            </label>
            <label v-if="selectedProfile.jumpMode === 'interactive-menu' && selectedProfile.gateway.authMode !== 'key'">
              <span>堡垒机密码</span>
              <input v-model="selectedProfile.gateway.password" type="password" autocomplete="off" placeholder="明文保存，用于自动登录" />
            </label>
            <label>
              <span>目标认证</span>
              <select v-model="selectedProfile.target.authMode">
                <option value="auto">auto</option>
                <option value="password">password</option>
                <option value="key">key</option>
              </select>
            </label>
            <label v-if="selectedProfile.target.authMode !== 'key'">
              <span>服务器密码</span>
              <input v-model="selectedProfile.target.password" type="password" autocomplete="off" placeholder="明文保存，用于自动登录" />
            </label>
          </div>
        </form>
      </div>
    </teleport>
  </aside>
</template>
