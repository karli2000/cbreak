import type { Role } from './api.ts'

export type Tab = 'reports' | 'live' | 'users' | 'bans' | 'audit' | 'admin'

export const TABS: { tab: Tab; label: string }[] = [
  { tab: 'reports', label: 'Reports' },
  { tab: 'live', label: 'Live' },
  { tab: 'users', label: 'Users' },
  { tab: 'bans', label: 'Bans' },
  { tab: 'audit', label: 'Audit' },
  { tab: 'admin', label: 'Admin' },
]

export function tabFromHash(hash: string, role: Role): Tab {
  const name = hash.replace(/^#\/?/, '')
  const found = TABS.find((t) => t.tab === name)
  if (!found) return 'reports'
  if (found.tab === 'admin' && role !== 'admin') return 'reports'
  return found.tab
}
