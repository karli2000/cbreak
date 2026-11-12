import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, type Bound, type Role } from '../api.ts'
import { useOnAuthError } from '../auth.tsx'
import { COPY, errorText } from '../copy.ts'

type Banned = { id: string; nickname: string; banned_at: string; ban_reason: string | null }

export function Bans({ api, role }: { api: Bound; role: Role }) {
  const onAuthError = useOnAuthError()
  const [items, setItems] = useState<Banned[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const gen = useRef(0)

  const load = useCallback(async () => {
    const mine = ++gen.current
    try {
      const rows = await api.listBanned()
      if (mine !== gen.current) return
      setItems(rows)
      setError(null)
    } catch (e) {
      onAuthError(e)
      if (mine !== gen.current) return
      setError(errorText(e instanceof ApiError ? e.code : 'unknown'))
    }
  }, [api, onAuthError])

  useEffect(() => {
    void load()
  }, [load])

  const admin = role === 'admin'
  return (
    <section aria-label="Bans">
      {error && <p role="alert">{error}</p>}
      {items === null && !error && <p>Loading…</p>}
      {items?.length === 0 && <p className="muted">Nobody is banned.</p>}
      {items && items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Nickname</th>
              <th>Banned at</th>
              <th>Reason</th>
              {admin && <th>Action</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((b) => (
              <BanRow key={b.id} b={b} admin={admin} api={api} reload={load} />
            ))}
          </tbody>
        </table>
      )}
      {admin && <GithubForm api={api} />}
    </section>
  )
}

function BanRow({ b, admin, api, reload }: { b: Banned; admin: boolean; api: Bound; reload: () => Promise<void> }) {
  const onAuthError = useOnAuthError()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const running = useRef(false)

  async function unban() {
    if (running.current) return
    if (!reason.trim()) return setError(COPY.reasonRequired)
    running.current = true
    setBusy(true)
    setError(null)
    try {
      await api.unban(b.id, reason.trim())
      await reload()
    } catch (e) {
      onAuthError(e)
      setError(errorText(e instanceof ApiError ? e.code : 'unknown'))
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  return (
    <tr>
      <td>{b.nickname}</td>
      <td>
        <time dateTime={b.banned_at}>{new Date(b.banned_at).toLocaleString()}</time>
      </td>
      <td className="snap-body">{b.ban_reason}</td>
      {admin && (
        <td>
          <input aria-label={`Reason for ${b.nickname}`} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />{' '}
          <button type="button" disabled={busy} onClick={() => void unban()}>
            Unban
          </button>
          {error && <p role="alert">{error}</p>}
        </td>
      )}
    </tr>
  )
}

function GithubForm({ api }: { api: Bound }) {
  const onAuthError = useOnAuthError()
  const [id, setId] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const running = useRef(false)

  async function submit(ev: React.FormEvent) {
    ev.preventDefault()
    if (running.current) return
    const trimmed = id.trim()
    if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) return setMsg({ ok: false, text: 'Enter a numeric GitHub id.' })
    if (!reason.trim()) return setMsg({ ok: false, text: COPY.reasonRequired })
    running.current = true
    setBusy(true)
    setMsg(null)
    try {
      await api.unbanGithubId(Number(trimmed), reason.trim())
      setId('')
      setReason('')
      setMsg({ ok: true, text: 'Unbanned.' })
    } catch (e) {
      onAuthError(e)
      const code = e instanceof ApiError ? e.code : 'unknown'
      setMsg({ ok: false, text: code === 'not_found' ? 'That GitHub id is not banned.' : errorText(code) })
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} aria-label="Unban by GitHub id">
      <h3>Unban a deleted account by GitHub id</h3>
      <label>
        GitHub id <input inputMode="numeric" value={id} onChange={(e) => setId(e.target.value)} />
      </label>{' '}
      <label>
        Reason for GitHub id <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </label>{' '}
      <button type="submit" disabled={busy}>
        Unban GitHub id
      </button>
      {msg && <p role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
    </form>
  )
}
