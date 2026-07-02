<script setup lang="ts">
import { ref } from 'vue'

interface TransferTask {
  id: string
  name: string
  size: number
  status: 'queued' | 'waiting-session'
}

const fileInput = ref<HTMLInputElement | null>(null)
const transferQueue = ref<TransferTask[]>([])
const remoteSessionActive = ref(false)

function triggerUpload() {
  fileInput.value?.click()
}

function queueUploads(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  transferQueue.value.push(
    ...files.map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}`,
      name: file.name,
      size: file.size,
      status: (remoteSessionActive.value ? 'queued' : 'waiting-session') as TransferTask['status']
    }))
  )
  input.value = ''
}

function formatSize(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <section class="files-panel">
    <div class="panel-head">
      <strong>Files</strong>
      <button class="icon-button" title="上传" aria-label="上传" @click="triggerUpload">↑</button>
      <input ref="fileInput" type="file" multiple class="visually-hidden" @change="queueUploads" />
    </div>
    <div class="file-list">
      <p v-if="transferQueue.length === 0" class="empty-state">
        {{ remoteSessionActive ? 'Ready: auto transfer' : 'Local terminal active. Remote file transfer starts after a real remote session is attached.' }}
      </p>
      <article v-for="task in transferQueue" :key="task.id" class="file-row">
        <div>
          <strong>{{ task.name }}</strong>
          <span>{{ formatSize(task.size) }} · {{ task.status }}</span>
        </div>
        <span class="badge" :class="{ warn: task.status === 'waiting-session' }">
          {{ task.status === 'queued' ? 'auto' : 'needs remote' }}
        </span>
      </article>
    </div>
  </section>
</template>
