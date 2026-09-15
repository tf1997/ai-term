<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { transferTasks } from '../../application/transferTaskManager'
import type { TransferJob } from '../../application/transferTaskManager'
import {
  formatSize,
  transferSpeedLabel,
  transferRemainingLabel,
  transferCompletionLabel,
} from '../../domain/transferPresentation'
import UiIcon from '../../../../shared/ui/UiIcon.vue'
import { trapTabFocus } from '../../../../shared/ui/overlays'
const emit = defineEmits<{ openLocation: [job: TransferJob] }>()
const id = useId(),
  open = ref(false),
  trigger = ref<HTMLButtonElement | null>(null),
  panel = ref<HTMLElement | null>(null)
const style = ref({ right: '12px', top: '88px' })
const feedback = ref('')
const jobs = computed(() => [...transferTasks.jobs.value].reverse())
const labels = { queued: '排队中', running: '传输中', done: '已完成', error: '失败', cancelled: '已取消' }
function toggle() {
  open.value = !open.value
  if (open.value) {
    const rect = trigger.value?.getBoundingClientRect()
    style.value = {
      right: `${Math.max(8, window.innerWidth - (rect?.right ?? window.innerWidth - 8))}px`,
      top: `${(rect?.bottom ?? 82) + 6}px`,
    }
    void nextTick(() => panel.value?.querySelector<HTMLButtonElement>('button')?.focus())
  }
}
function close() {
  open.value = false
  void nextTick(() => trigger.value?.focus())
}
function escapeWhileOpen(event: KeyboardEvent) {
  if (open.value && event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close()
  }
}
watch(open, (value) => {
  if (value) window.addEventListener('keydown', escapeWhileOpen)
  else window.removeEventListener('keydown', escapeWhileOpen)
})
watch(
  () => jobs.value.map((job) => job.status).join('|'),
  () => {
    if (open.value && !panel.value?.contains(document.activeElement))
      panel.value?.querySelector<HTMLButtonElement>('button')?.focus()
  },
  { flush: 'post' },
)
onBeforeUnmount(() => window.removeEventListener('keydown', escapeWhileOpen))
function locate(job: (typeof jobs.value)[number]) {
  open.value = false
  emit('openLocation', job as TransferJob)
}
async function copyResult(path: string) {
  try {
    await navigator.clipboard.writeText(path)
    feedback.value = '已复制结果路径'
  } catch {
    feedback.value = '复制失败，请选择路径后手动复制。'
  }
}
</script>

<template>
  <button
    ref="trigger"
    class="session-task-toggle"
    type="button"
    :aria-expanded="open"
    :aria-controls="id"
    @click="toggle"
  >
    <UiIcon name="download" size="14" /><span>传输</span
    ><span v-if="transferTasks.activeCount.value" class="file-task-count">{{
      transferTasks.activeCount.value
    }}</span>
  </button>
  <Teleport to="body">
    <div v-if="open" class="file-popover-scrim" @click="close" />
    <section
      v-if="open"
      :id="id"
      ref="panel"
      class="file-task-center"
      :style="style"
      role="dialog"
      aria-label="全部文件传输"
      @keydown.esc.prevent.stop="close"
      @keydown="trapTabFocus($event, $event.currentTarget as HTMLElement)"
    >
      <header>
        <div>
          <strong>文件传输</strong><span>{{ transferTasks.activeCount.value }} 项进行中</span>
        </div>
        <div>
          <button type="button" @click="transferTasks.clearCompleted">清除已结束</button
          ><button class="icon-button" type="button" aria-label="关闭传输列表" @click="close">
            <UiIcon name="close" size="16" />
          </button>
        </div>
      </header>
      <p v-if="feedback" class="file-task-feedback" role="status">{{ feedback }}</p>
      <div v-if="!jobs.length" class="file-grid-empty">
        <strong>暂无传输任务</strong>
        <p>上传和下载会在这里显示，切换终端不影响任务。</p>
      </div>
      <ol v-else class="file-task-list">
        <li v-for="job in jobs" :key="job.id" :class="job.status">
          <div class="file-task-title">
            <UiIcon :name="job.direction === 'upload' ? 'upload' : 'download'" size="16" /><strong
              :title="job.itemName"
              >{{ job.itemName }}</strong
            ><span
              >{{ job.cancelling ? '正在取消' : labels[job.status]
              }}<template v-if="job.status === 'running' && job.progressPercent">
                · {{ Math.round(job.progressPercent) }}%</template
              ></span
            >
          </div>
          <div class="file-task-owner">
            {{ job.binding.label }} · {{ job.mode === 'terminal' ? '终端传输' : 'SFTP' }}
          </div>
          <div class="file-task-paths">
            <span :title="job.sourcePath">{{ job.sourcePath }}</span
            ><UiIcon name="arrow-right" size="13" /><span :title="job.targetPath">{{ job.targetPath }}</span>
          </div>
          <progress
            v-if="job.status === 'running'"
            max="100"
            :value="job.progressPercent ?? undefined"
            :aria-label="`${job.itemName} 进度`"
          />
          <div v-if="job.status === 'running'" class="file-task-metrics">
            <span>速度 {{ transferSpeedLabel(job) }}</span
            ><span>剩余 {{ transferRemainingLabel(job) }}</span>
          </div>
          <div class="file-task-bottom">
            <span v-if="job.status === 'error'" role="status">{{ job.progressText }}</span
            ><span v-else-if="job.transferredBytes !== undefined"
              >{{ formatSize(job.transferredBytes)
              }}<template v-if="job.totalBytes"> / {{ formatSize(job.totalBytes) }}</template></span
            ><span v-else>{{ job.direction === 'upload' ? '上传' : '下载' }}</span
            ><button
              v-if="job.status === 'running' || job.status === 'queued'"
              type="button"
              :disabled="job.cancelling"
              @click="transferTasks.cancel(job.id)"
            >
              取消
            </button>
            <div v-else-if="job.status === 'done'" class="file-task-result-actions">
              <button type="button" @click="copyResult(job.targetPath)">复制路径</button
              ><button type="button" @click="locate(job)">打开位置</button>
            </div>
          </div>
          <time
            v-if="job.completedAt"
            class="file-task-completed"
            :datetime="new Date(job.completedAt).toISOString()"
            >{{ transferCompletionLabel(job) }}</time
          >
        </li>
      </ol>
    </section>
  </Teleport>
</template>
