import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, type Bound, type Report, type Role } from '../api.ts'
import { useOnAuthError } from '../auth.tsx'
import { errorText } from '../copy.ts'
import { ActionBar } from '../components/ActionBar.tsx'
import { Snapshot } from '../components/Snapshot.tsx'

type Names = Map<string, { nickname: string; role: Role }>
const STATUSES: { value: Report['status']; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: 'actioned', label: 'Actioned' },
]

function age(iso: string): string {
  const min = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000))
  if (min < 60) return `${min} min ago`
  if (min < 1440) return `${Math.floor(min / 60)} h ago`
  return `${Math.floor(min / 1440)} d ago`
}

export function Reports({ api }: { api: Bound }) {
  const onAuthError = useOnAuthError()
  const [status, setStatus] = useState<Report['status']>('open')
  const [items, setItems] = useState<Report[] | null>(null)
  const [nameMap, setNameMap] = useState<Names>(new Map())
  const [error, setError] = useState<string | null>(null)

  const gen = useRef(0)
  const load = useCallback(async () => {
    const mine = ++gen.current
    try {
      const rows = await api.listReports(status)
      const ids = rows.flatMap((r) => [r.reporter_id, r.target_id].filter((x): x is string => x !== null))
      const nm = await api.names(ids)
      if (mine !== gen.current) return
      setNameMap(nm)
      setItems(rows)
      setError(null)
    } catch (e) {
      onAuthError(e)
      if (mine !== gen.current) return
      setError(errorText(e instanceof ApiError ? e.code : 'unknown'))
    }
  }, [api, status, onAuthError])

  useEffect(() => {
    setItems(null)
    setError(null)
    void load()
  }, [load])

  return (
    <section aria-label="Reports">
      <label>
        Status{' '}
        <select value={status} onChange={(e) => setStatus(e.target.value as Report['status'])}>
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      {items === null && !error && <p>Loading…</p>}
      {items?.length === 0 && <p className="muted">No {status} reports.</p>}
      <ul className="reports">
        {items?.map((r) => (
          <ReportItem key={r.id} r={r} names={nameMap} api={api} reload={load} />
        ))}
      </ul>
    </section>
  )
}

function ReportItem({ r, names, api, reload }: { r: Report; names: Names; api: Bound; reload: () => Promise<void> }) {
  const onAuthError = useOnAuthError()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const who = (id: string | null) => (id ? (names.get(id)?.nickname ?? 'deleted user') : 'deleted user')
  const target = r.target_id ? { userId: r.target_id, nickname: who(r.target_id) } : null

  async function resolve(status: 'dismissed' | 'actioned') {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api.resolveReport(r.id, status)
      await reload()
    } catch (e) {
      onAuthError(e)
      setError(errorText(e instanceof ApiError ? e.code : 'unknown'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="report">
      <h2>{`${who(r.reporter_id)} → ${who(r.target_id)}`}</h2>
      <p className="muted">
        {r.room !== null ? `${r.room} · ${r.instance}` : 'no room'} · <time dateTime={r.created_at}>{age(r.created_at)}</time>
      </p>
      <p className="snap-body">{r.reason}</p>
      <Snapshot snapshot={r.snapshot} highlightId={r.message_id} />
      {r.status === 'open' && (
        <>
          {target && <ActionBar target={target} messageId={r.message_id} actions={['delete', 'mute', 'ban']} api={api} onDone={() => void reload()} />}
          <div className="actions-buttons">
            <button type="button" disabled={busy} onClick={() => void resolve('dismissed')}>
              Dismiss
            </button>
            <button type="button" disabled={busy} onClick={() => void resolve('actioned')}>
              Mark actioned
            </button>
          </div>
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </li>
  )
}
