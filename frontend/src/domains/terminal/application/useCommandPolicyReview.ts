import { onBeforeUnmount, shallowRef } from 'vue'
import type { InjectionKey } from 'vue'
import type { CommandIntent } from '../../../shared/security/commandPolicy'

export interface CommandReviewItem { intent: CommandIntent; label: string }
export type CommandReviewer = (items: CommandReviewItem[], note?: string) => Promise<boolean>
export const commandReviewerKey: InjectionKey<CommandReviewer> = Symbol('command-policy-review')

export function useCommandPolicyReview() {
  const pending = shallowRef<{ items: CommandReviewItem[]; note?: string; resolve: (value: boolean) => void } | null>(null)
  const review: CommandReviewer = (items, note) => {
    // A second action cannot replace the content underneath a user's approval.
    if (pending.value) return Promise.reject(new Error('请先完成或取消当前命令审查'))
    return new Promise(resolve => { pending.value = { items, note, resolve } })
  }
  function resolve(value: boolean) {
    const current = pending.value
    pending.value = null
    current?.resolve(value)
  }
  onBeforeUnmount(() => resolve(false))
  return { pending, review, resolve }
}
