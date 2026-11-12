import { useEffect, useRef, useState } from 'react'
import { ApiError, type Bound, type ModAction, type Role } from '../api.ts'
import { useOnAuthError } from '../auth.tsx'
import { errorText } from '../copy.ts'

export const ACTIONS = [
  'mod_delete_message',
  'mod_mute',
  'mod_unmute',
  'mod_ban',
  'mod_resolve_report',
  'admin_unban',
  'admin_set_role',
  'admin_upsert_room',
  'admin_add_filter',
  'admin_remove_filter',
  'admin_unban_github_id',
  'auto_mute',
]

type Filters = { action?: string; actorId?: string; targetId?: string }
type Who = Map<string, { nickname: string; role: Role }>

function detailsText(d: Record<string, unknown>): string {
  return Object.entries(d ?? {})
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ')
}

const clean = (s: string) => s.trim().toLowerCase().replace(/^@/, '')

export function Audit({ api, pageSize = 50 }: { api: Bound; pageSize?: number }) {
  const onAuthError = useOnAuthError()
  const [action, setAction] = useState('')
  const [actor, setActor] = useState('')
  const [target, setTarget] = useState('')
  const [rows, setRows] = useState<ModAction[]>([])
  const [who, setWho] = useState<Who>(new Map())
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const applied = useRef<Filters>({})
  const gen = useRef(0)
  const busy = useRef(false)

  async function load(filters: Filters, append: boolean, current: ModAction[]) {
    const mine = ++gen.current
    busy.current = true
    setLoading(true)
    setError(null)
    try {
      const last = append ? current[current.length - 1] : undefined
      const page = await api.listActions(last ? { ...filters, before: { created_at: last.created_at, id: last.id } } : filters, pageSize)
      const ids = page.flatMap((a) => [a.actor_id, a.target_id]).filter((x): x is string => x !== null)
      const found = await api.names(ids).catch((e: unknown) => {
        onAuthError(e)
        return new Map() as Who
      })
      if (mine !== gen.current) return
      setWho((w) => new Map([...(append ? w : []), ...found]))
      setRows(append ? [...current, ...page] : page)
      setMore(page.length === pageSize)
    } catch (e) {
      onAuthError(e)
      if (mine !== gen.current) return
      setError(errorText(e instanceof ApiError ? e.code : 'unknown'))
    } finally {
      if (mine === gen.current) {
        busy.current = false
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    void load({}, false, [])
    return () => {
      gen.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function resolve(nick: string): Promise<string | undefined> {
    const n = clean(nick)
    if (!n) return undefined
    return (await api.lookupUser(n)).profile.id
  }

  async function submit(ev: React.FormEvent) {
    ev.preventDefault()
    const mine = ++gen.current
    setError(null)
    try {
      const [actorId, targetId] = await Promise.all([resolve(actor), resolve(target)])
      if (mine !== gen.current) return
      const f: Filters = {}
      if (action) f.action = action
      if (actorId) f.actorId = actorId
      if (targetId) f.targetId = targetId
      applied.current = f
      await load(f, false, [])
    } catch (e) {
      onAuthError(e)
      if (mine !== gen.current) return
      const code = e instanceof ApiError ? e.code : 'unknown'
      setError(code === 'not_found' ? 'No user with that nickname.' : errorText(code))
      setLoading(false)
    }
  }

  return (
    <section aria-label="Audit">
      <form onSubmit={(e) => void submit(e)}>
        <label>
          Action{' '}
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">All</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          Actor <input value={actor} onChange={(e) => setActor(e.target.value)} />
        </label>{' '}
        <label>
          Target <input value={target} onChange={(e) => setTarget(e.target.value)} />
        </label>{' '}
        <button type="submit">Filter</button>
      </form>
      {error && <p role="alert">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Target</th>
            <th>Reason</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <td>
                <time dateTime={a.created_at}>{new Date(a.created_at).toLocaleString()}</time>
              </td>
              <td>{a.actor_id === null ? 'system' : (who.get(a.actor_id)?.nickname ?? 'deleted user')}</td>
              <td>{a.action}</td>
              <td>{a.target_id === null ? '—' : (who.get(a.target_id)?.nickname ?? 'deleted user')}</td>
              <td className="snap-body">{a.reason ?? ''}</td>
              <td className="snap-body">{detailsText(a.details)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!loading && rows.length === 0 && !error && <p className="muted">No actions.</p>}
      {more && (
        <button disabled={loading} onClick={() => !busy.current && void load(applied.current, true, rows)}>
          Load more
        </button>
      )}
      <p className="muted">Actions are kept for 1 year.</p>
    </section>
  )
}
