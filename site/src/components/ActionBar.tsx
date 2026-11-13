import { useEffect, useId, useRef, useState } from 'react'
import { ApiError, type Bound } from '../api.ts'
import { useOnAuthError } from '../auth.tsx'
import { COPY, errorText } from '../copy.ts'

type Action = 'delete' | 'mute' | 'ban' | 'unmute' | 'unban'
const CONFIRM_MS = 5000
/** Clicks this soon after arming are ignored: a double-click on Ban must not count as Confirm ban. */
export const ARM_MS = 500

export function ActionBar({
  target,
  messageId = null,
  onDone,
  actions,
  api,
}: {
  target: { userId: string; nickname: string }
  messageId?: number | null
  onDone(): void
  actions: Action[]
  api: Bound
}) {
  const onAuthError = useOnAuthError()
  const id = useId()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const running = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const armedAt = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])

  async function run(f: () => Promise<void>, notFound?: string) {
    if (running.current) return
    running.current = true
    clearTimeout(timer.current)
    setConfirming(false)
    setBusy(true)
    setError(null)
    try {
      await f()
      setReason('')
      onDone()
    } catch (e) {
      onAuthError(e)
      const code = e instanceof ApiError ? e.code : 'unknown'
      setError(notFound && code === 'not_found' ? notFound : errorText(code))
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  const trimmed = reason.trim()
  const needReason = (): boolean => {
    if (trimmed) return true
    setError(COPY.reasonRequired)
    return false
  }

  const has = (a: Action) => actions.includes(a)
  const mute = (m: 10 | 60 | 1440, label: string) => (
    <button key={label} type="button" disabled={busy} onClick={() => needReason() && void run(() => api.mute(target.userId, m, trimmed))}>
      {label}
    </button>
  )
  const onBan = () => {
    if (!needReason()) return
    if (!confirming) {
      setConfirming(true)
      armedAt.current = Date.now()
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setConfirming(false), CONFIRM_MS)
      return
    }
    if (Date.now() - armedAt.current < ARM_MS) return // the same button in the same place
    clearTimeout(timer.current)
    setConfirming(false)
    void run(() => api.ban(target.userId, trimmed))
  }

  return (
    <div className="actions">
      <label htmlFor={id}>Reason</label>{' '}
      <input id={id} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      <div className="actions-buttons">
        {has('delete') && messageId !== null && (
          <button type="button" disabled={busy} onClick={() => void run(() => api.deleteMessage(messageId, trimmed), COPY.expiredMessage)}>
            Delete message
          </button>
        )}
        {has('mute') && [mute(10, 'Mute 10m'), mute(60, 'Mute 1h'), mute(1440, 'Mute 24h')]}
        {has('unmute') && (
          <button type="button" disabled={busy} onClick={() => needReason() && void run(() => api.unmute(target.userId, trimmed))}>
            Unmute
          </button>
        )}
        {has('ban') && (
          <button type="button" disabled={busy} onClick={onBan}>
            {confirming ? 'Confirm ban' : 'Ban'}
          </button>
        )}
        {has('unban') && (
          <button type="button" disabled={busy} onClick={() => needReason() && void run(() => api.unban(target.userId, trimmed))}>
            Unban
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
