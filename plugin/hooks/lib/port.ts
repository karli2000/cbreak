// The Controller's view of the world: every side effect goes through `Port`, and the pane is
// drawn from a plain `PaneView`. Types only (runs in the mod environment).
import type { Api, ApiPath, ApiResult, HelperEvent, Role } from '../../shared/protocol.ts'
import type { Segment } from './format.ts'
import type { Settings } from './settings.ts'

export interface Timer {
  cancel(): void
}

export interface Port {
  spawnHelper(
    onEvent: (e: HelperEvent) => void,
    onExit: (info: { code: number | null; signal: string | null; stderr: string }) => void,
  ): void
  stopHelper(): void
  call<P extends ApiPath>(socket: string, path: P, body: Api[P]['req']): Promise<ApiResult<P>>
  /** `title` is COPY.title. */
  openPane(focus: boolean, title: string): Promise<{ placed: boolean }>
  /** false when refused or threw. */
  closePane(): Promise<boolean>
  redraw(): void
  scrollToEnd(): void
  status(text: string | undefined): void
  toast(text: string): void
  after(ms: number, fn: () => void): Timer
  loadSettings(): Promise<Settings>
  saveSettings(s: Settings): Promise<void>
}

export type Line =
  | { kind: 'message'; id: number; nickname: string; color: string; action: boolean; segments: Segment[]; role?: Role }
  | { kind: 'system'; text: string }

export type PaneView =
  /** `countdown`: drawn at the right of the input while the grace period runs (`closes in N s`), else null. */
  | { mode: 'chat'; header: string; busy: boolean; lines: Line[]; draft: string; inputEnabled: boolean; countdown: string | null }
  | { mode: 'setup'; lines: string[]; draft: string; placeholder: string }
