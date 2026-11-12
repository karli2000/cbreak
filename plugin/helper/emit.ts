import type { HelperEvent } from '../shared/protocol'

/** NDJSON writer. A broken pipe calls onBrokenPipe once and never throws. */
export function createEmitter(
  write: (s: string) => boolean | void,
  onBrokenPipe: () => void,
): (e: HelperEvent) => void {
  let broken = false
  return (e) => {
    if (broken) return
    try {
      write(JSON.stringify(e) + '\n')
    } catch (err) {
      const code = (err as { code?: string })?.code
      if (code !== 'EPIPE' && code !== 'ERR_STREAM_DESTROYED') throw err
      broken = true
      onBrokenPipe()
    }
  }
}
