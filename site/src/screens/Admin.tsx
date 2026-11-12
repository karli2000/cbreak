import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, type Bound, type Role, type Room } from '../api.ts'
import { useOnAuthError } from '../auth.tsx'
import { COPY, errorText } from '../copy.ts'

const SLUG = /^[a-z0-9-]{2,32}$/
const SLUG_TEXT = 'Room names are 2–32 characters: a–z, 0–9 and -.'
const ROLES: Role[] = ['user', 'moderator', 'admin']

/** Runs an api call once at a time, routes failures through onAuthError, and keeps the message. */
function useGuarded() {
  const onAuthError = useOnAuthError()
  const running = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const run = useCallback(
    async (f: () => Promise<void>, codeText?: (code: string) => string | undefined): Promise<boolean> => {
      if (running.current) return false
      running.current = true
      setBusy(true)
      setError(null)
      try {
        await f()
        return true
      } catch (e) {
        onAuthError(e)
        const code = e instanceof ApiError ? e.code : 'unknown'
        if (alive.current) setError(codeText?.(code) ?? errorText(code))
        return false
      } finally {
        running.current = false
        if (alive.current) setBusy(false)
      }
    },
    [onAuthError],
  )
  return { busy, error, setError, run }
}

type Staff = { id: string; nickname: string; role: Role }

export function Admin({ api }: { api: Bound }) {
  return (
    <section aria-label="Admin">
      <StaffSection api={api} />
      <RoomsSection api={api} />
      <FilterSection api={api} />
    </section>
  )
}

function useList<T>(load: () => Promise<T[]>): { items: T[] | null; error: string | null; reload(): Promise<void> } {
  const onAuthError = useOnAuthError()
  const [items, setItems] = useState<T[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const gen = useRef(0)
  const loadRef = useRef(load)
  loadRef.current = load
  const reload = useCallback(async () => {
    const mine = ++gen.current
    try {
      const r = await loadRef.current()
      if (mine !== gen.current) return
      setItems(r)
      setError(null)
    } catch (e) {
      onAuthError(e)
      if (mine !== gen.current) return
      setError(errorText(e instanceof ApiError ? e.code : 'unknown'))
    }
  }, [onAuthError])
  useEffect(() => {
    void reload()
    return () => {
      gen.current++
    }
  }, [reload])
  return { items, error, reload }
}

function StaffSection({ api }: { api: Bound }) {
  const { items, error, reload } = useList<Staff>(() => api.listStaff())
  const add = useGuarded()
  const [nick, setNick] = useState('')

  async function submit(ev: React.FormEvent) {
    ev.preventDefault()
    const n = nick.trim().toLowerCase().replace(/^@/, '')
    if (!n) {
      add.setError('Enter a nickname.')
      return
    }
    const ok = await add.run(
      async () => {
        const u = await api.lookupUser(n)
        await api.setRole(u.profile.id, 'moderator')
      },
      (code) => (code === 'not_found' ? 'No user with that nickname.' : undefined),
    )
    if (ok) {
      setNick('')
      await reload()
    }
  }

  return (
    <section aria-label="Staff">
      <h2>Staff</h2>
      {error && <p role="alert">{error}</p>}
      <ul className="reports">
        {items?.map((s) => (
          <StaffRow key={s.id} staff={s} api={api} onChanged={reload} />
        ))}
      </ul>
      <form onSubmit={(e) => void submit(e)}>
        <label>
          Add moderator <input value={nick} onChange={(e) => setNick(e.target.value)} />
        </label>{' '}
        <button type="submit" disabled={add.busy}>
          Add moderator
        </button>
      </form>
      {add.error && <p role="alert">{add.error}</p>}
    </section>
  )
}

function StaffRow({ staff, api, onChanged }: { staff: Staff; api: Bound; onChanged(): Promise<void> }) {
  const g = useGuarded()
  const [confirmAdmin, setConfirmAdmin] = useState(false)
  async function apply(role: Role) {
    setConfirmAdmin(false)
    if (await g.run(() => api.setRole(staff.id, role))) await onChanged()
  }
  function change(role: Role) {
    if (role === staff.role) return
    // Promoting to admin cannot be undone here: the server refuses any action on an admin.
    if (role === 'admin') {
      setConfirmAdmin(true)
      return
    }
    void apply(role)
  }
  return (
    <li className="report">
      <strong>{staff.nickname}</strong>{' '}
      {staff.role === 'admin' ? (
        <span className="muted">admin</span>
      ) : (
        <label>
          <span className="muted">Role of {staff.nickname}</span>{' '}
          <select value={staff.role} disabled={g.busy || confirmAdmin} onChange={(e) => change(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      )}
      {confirmAdmin && (
        <div className="actions-buttons">
          <span>{COPY.adminIsFinal}</span>{' '}
          <button type="button" disabled={g.busy} onClick={() => void apply('admin')}>
            Make {staff.nickname} admin
          </button>{' '}
          <button type="button" disabled={g.busy} onClick={() => setConfirmAdmin(false)}>
            Cancel
          </button>
        </div>
      )}
      {g.error && <p role="alert">{g.error}</p>}
    </li>
  )
}

function RoomsSection({ api }: { api: Bound }) {
  const { items, error, reload } = useList<Room>(() => api.listRooms())
  return (
    <section aria-label="Rooms">
      <h2>Rooms</h2>
      {error && <p role="alert">{error}</p>}
      {items?.map((r) => (
        <RoomRow key={r.slug} room={r} api={api} onSaved={reload} />
      ))}
      <NewRoom api={api} onSaved={reload} />
    </section>
  )
}

function RoomRow({ room, api, onSaved }: { room: Room; api: Bound; onSaved(): Promise<void> }) {
  const g = useGuarded()
  const [title, setTitle] = useState(room.title)
  const [kind, setKind] = useState(room.kind)
  const [lang, setLang] = useState(room.lang ?? '')
  const [open, setOpen] = useState(room.is_open)
  async function save() {
    if (!title.trim()) {
      g.setError('Enter a title.')
      return
    }
    const ok = await g.run(() => api.upsertRoom({ slug: room.slug, title: title.trim(), kind: kind.trim(), lang: lang.trim() || null, is_open: open }))
    if (ok) await onSaved()
  }
  return (
    <fieldset>
      <legend>{room.slug}</legend>
      <label>
        <span className="muted">Title of {room.slug}</span> <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>{' '}
      <label>
        <span className="muted">Kind of {room.slug}</span> <input value={kind} onChange={(e) => setKind(e.target.value)} />
      </label>{' '}
      <label>
        <span className="muted">Language of {room.slug}</span> <input value={lang} onChange={(e) => setLang(e.target.value)} />
      </label>{' '}
      <label>
        <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> <span>Open {room.slug}</span>
      </label>{' '}
      <button disabled={g.busy} onClick={() => void save()}>
        Save {room.slug}
      </button>
      {g.error && <p role="alert">{g.error}</p>}
    </fieldset>
  )
}

function NewRoom({ api, onSaved }: { api: Bound; onSaved(): Promise<void> }) {
  const g = useGuarded()
  const [slug, setSlug] = useState('')
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState('public')
  const [lang, setLang] = useState('')
  const [open, setOpen] = useState(true)
  async function create(ev: React.FormEvent) {
    ev.preventDefault()
    const s = slug.trim()
    if (!SLUG.test(s)) {
      g.setError(SLUG_TEXT)
      return
    }
    if (!title.trim()) {
      g.setError('Enter a title.')
      return
    }
    const ok = await g.run(() => api.upsertRoom({ slug: s, title: title.trim(), kind: kind.trim() || 'public', lang: lang.trim() || null, is_open: open }))
    if (ok) {
      setSlug('')
      setTitle('')
      setLang('')
      await onSaved()
    }
  }
  return (
    <form onSubmit={(e) => void create(e)}>
      <h3>New room</h3>
      <label>
        New room slug <input value={slug} onChange={(e) => setSlug(e.target.value)} />
      </label>{' '}
      <label>
        New room title <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>{' '}
      <label>
        New room kind <input value={kind} onChange={(e) => setKind(e.target.value)} />
      </label>{' '}
      <label>
        New room language <input value={lang} onChange={(e) => setLang(e.target.value)} />
      </label>{' '}
      <label>
        <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> New room open
      </label>{' '}
      <button type="submit" disabled={g.busy}>
        Create room
      </button>
      {g.error && <p role="alert">{g.error}</p>}
    </form>
  )
}

type Filter = { id: number; pattern: string; created_at: string }

function FilterSection({ api }: { api: Bound }) {
  const { items, error, reload } = useList<Filter>(() => api.listFilters())
  const add = useGuarded()
  const [pattern, setPattern] = useState('')

  async function submit(ev: React.FormEvent) {
    ev.preventDefault()
    if (!pattern.trim()) {
      add.setError('Enter a pattern.')
      return
    }
    if (await add.run(async () => void (await api.addFilter(pattern)))) {
      setPattern('')
      await reload()
    }
  }

  return (
    <section aria-label="Word filter">
      <h2>Word filter</h2>
      <p className="muted">Patterns are case-insensitive regular expressions.</p>
      {error && <p role="alert">{error}</p>}
      <ul className="reports">
        {items?.map((f) => (
          <FilterRow key={f.id} filter={f} api={api} onRemoved={reload} />
        ))}
      </ul>
      <form onSubmit={(e) => void submit(e)}>
        <label>
          Add pattern <input value={pattern} onChange={(e) => setPattern(e.target.value)} />
        </label>{' '}
        <button type="submit" disabled={add.busy}>
          Add pattern
        </button>
      </form>
      {add.error && <p role="alert">{add.error}</p>}
    </section>
  )
}

function FilterRow({ filter, api, onRemoved }: { filter: Filter; api: Bound; onRemoved(): Promise<void> }) {
  const g = useGuarded()
  async function remove() {
    if (await g.run(() => api.removeFilter(filter.id))) await onRemoved()
  }
  return (
    <li className="report">
      <code className="snap-body">{filter.pattern}</code>{' '}
      <button disabled={g.busy} onClick={() => void remove()}>
        Remove
      </button>
      {g.error && <p role="alert">{g.error}</p>}
    </li>
  )
}
