import type { ContextMenuItem } from '../../../shared/ui/overlays'
import { terminalDisplayTitle } from '../domain/terminalTabs'

interface TabMenuOptions {
  tabs: readonly { id: string; title: string }[]
  tabId: string
  activeId: string
  targetIds: readonly string[]
  select: (id: string) => void
  toggleTarget: (id: string) => void
  create: () => void
  close: (id: string) => void
  closeOthers: (id: string) => void
  closeRight: (id: string) => void
}

export function terminalContextMenu(options: TabMenuOptions) {
  const { tabs, tabId, activeId, targetIds } = options
  const index = tabs.findIndex(tab => tab.id === tabId)
  if (index < 0) return undefined
  const items: ContextMenuItem[] = []
  if (tabId !== activeId) items.push({ id: 'switch', label: '切换到此终端', group: 'common', restoreFocus: false, action: () => options.select(tabId) })
  items.push({ id: 'new-local', label: '新建本地终端', group: 'common', restoreFocus: false, action: options.create })
  if (tabId !== activeId) items.push({
    id: 'toggle-target', label: targetIds.includes(tabId) ? '从同步目标移除' : '加入同步目标',
    group: 'sync', action: () => options.toggleTarget(tabId),
  })
  items.push({
    id: 'close', label: '关闭此终端', group: 'close', danger: true,
    disabled: tabs.length === 1, disabledReason: tabs.length === 1 ? '至少保留一个终端' : undefined,
    action: () => options.close(tabId),
  })
  if (tabs.length > 1) items.push({ id: 'close-others', label: '关闭其他终端', group: 'close', danger: true, action: () => options.closeOthers(tabId) })
  if (index < tabs.length - 1) items.push({ id: 'close-right', label: '关闭右侧终端', group: 'close', danger: true, action: () => options.closeRight(tabId) })
  return {
    title: terminalDisplayTitle(tabs[index], tabs),
    description: tabId === activeId ? '当前终端始终接收输入' : undefined,
    items,
  }
}
