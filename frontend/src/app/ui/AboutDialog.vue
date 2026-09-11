<script setup lang="ts">
import UiIcon from '../../shared/ui/UiIcon.vue'
import { formatError } from '../../shared/platform/errors'
import type { ToastKind } from '../../shared/ui/overlays'

const props = defineProps<{
  appTheme: string
  rightCollapsed: boolean
  workspacePanelTab: string
  aboutRuntimeStats: Array<{ label: string; value: string }>
  terminalCount: number
  profileCount: number
  sessionCount: number
}>()
const emit = defineEmits<{ close: []; toast: [kind: ToastKind, title: string, message?: string] }>()
const closeAboutPage = () => emit('close')

type AboutSignalIcon = 'ai' | 'database' | 'network' | 'shield' | 'terminal'

interface AboutSignal {
  icon: AboutSignalIcon
  label: string
  value: string
}

const APP_VERSION = '0.1.0'

const APP_CHANNEL = 'Stable'

const APP_LICENSE = 'Apache-2.0'

const APP_AUTHOR = 'tf1997 & gpt-5.5 & gpt-5.6-sol'

const aboutSignals: AboutSignal[] = [
  { icon: 'terminal', label: 'Terminal Core', value: 'PTY / SSH' },
  { icon: 'ai', label: 'AI Runtime', value: 'Command / Script' },
  { icon: 'network', label: 'Transfer Mesh', value: 'SFTP / Bastion' },
  { icon: 'shield', label: 'Safety Layer', value: 'Keys / Risk' },
  { icon: 'database', label: 'Local Store', value: 'SQLite / Keychain' }
]

async function copyAboutInfo() {
  if (!navigator.clipboard?.writeText) {
    emit('toast', 'error', '复制失败', '当前环境不支持剪贴板写入。')
    return
  }
  const info = [
    `AI Term v${APP_VERSION}`,
    `Author: ${APP_AUTHOR}`,
    `Channel: ${APP_CHANNEL}`,
    `License: ${APP_LICENSE}`,
    `Theme: ${props.appTheme}`,
    `Terminal tabs: ${props.terminalCount}`,
    `Saved connections: ${props.profileCount}`,
    `Active workspace sessions: ${props.sessionCount}`,
    `Workspace panel: ${props.rightCollapsed ? 'collapsed' : props.workspacePanelTab}`
  ].join('\n')
  try {
    await navigator.clipboard.writeText(info)
    emit('toast', 'success', '关于信息已复制', '版本与运行状态已写入剪贴板。')
  } catch (error) {
    emit('toast', 'error', '复制失败', formatError(error))
  }
}
</script>

<template>
    <div class="modal-backdrop about-backdrop" role="presentation" @click.self="closeAboutPage">
      <section class="modal about-modal" role="dialog" aria-modal="true" aria-labelledby="about-title" aria-describedby="about-summary">
        <div class="modal-head about-head">
          <div>
            <strong id="about-title">关于 AI Term</strong>
            <span>v{{ APP_VERSION }} · {{ APP_CHANNEL }} · {{ APP_LICENSE }}</span>
          </div>
          <button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="closeAboutPage"><UiIcon name="close" /></button>
        </div>
        <div class="about-body">
          <section class="about-hero">
            <div class="about-copy">
              <span class="about-kicker">AI TERM / SECURE OPS</span>
              <h2>AI Term</h2>
              <p id="about-summary">面向服务器操作的 AI 终端工作台。</p>
              <div class="about-version-strip" aria-label="版本信息">
                <span>v{{ APP_VERSION }}</span>
                <span>{{ APP_CHANNEL }}</span>
                <span>{{ APP_LICENSE }}</span>
              </div>
              <div class="about-source" aria-label="作者">
                <span>Author {{ APP_AUTHOR }}</span>
              </div>
            </div>
            <div class="about-visual" aria-hidden="true">
              <div class="about-visual-top">
                <span />
                <span />
                <span />
              </div>
              <div class="about-scan-grid">
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
              </div>
              <div class="about-terminal-lines">
                <span>$ ai-term boot --workspace</span>
                <span>ssh route ........... online</span>
                <span>sftp mesh ........... ready</span>
                <span>script guard ........ armed</span>
              </div>
            </div>
          </section>
          <section class="about-runtime" aria-label="运行信息">
            <article v-for="item in aboutRuntimeStats" :key="item.label">
              <span>{{ item.label }}</span>
              <strong>{{ item.value }}</strong>
            </article>
          </section>
          <section class="about-signal-grid" aria-label="能力矩阵">
            <article v-for="item in aboutSignals" :key="item.label" class="about-signal">
              <span class="about-signal-icon"><UiIcon :name="item.icon" /></span>
              <div>
                <strong>{{ item.label }}</strong>
                <small>{{ item.value }}</small>
              </div>
            </article>
          </section>
          <section class="about-command-panel" aria-label="运行摘要">
            <div class="about-command-head">
              <span>runtime://summary</span>
              <strong>ready</strong>
            </div>
            <div class="about-build-grid">
              <article>
                <span>Version</span>
                <strong>{{ APP_VERSION }}</strong>
              </article>
              <article>
                <span>Channel</span>
                <strong>{{ APP_CHANNEL }}</strong>
              </article>
              <article>
                <span>Theme</span>
                <strong>{{ appTheme }}</strong>
              </article>
              <article>
                <span>Workspace</span>
                <strong>{{ rightCollapsed ? 'compact' : workspacePanelTab }}</strong>
              </article>
            </div>
          </section>
        </div>
        <div class="modal-actions about-actions">
          <button type="button" @click="copyAboutInfo">
            <UiIcon name="copy" size="14" />
            <span>复制信息</span>
          </button>
          <button class="primary" type="button" @click="closeAboutPage">完成</button>
        </div>
      </section>
    </div>
</template>
