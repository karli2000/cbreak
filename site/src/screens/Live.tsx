import { useCallback, useEffect, useRef, useState } from 'react'
import { nickColor } from '../../../plugin/hooks/lib/format.ts'
import { ApiError, type Bound, type ChatMessage } from '../api.ts'
import { useOnAuthError } from '../auth.tsx'
import { errorText } from '../copy.ts'
import { ActionBar } from '../components/ActionBar.tsx'

type Instance = { room: string; instance: number; here: number }
type Pick = { room: string; instance: number }
const MAX_LINES = 300
const REFRESH_MS = 30_000

export function Live({ api }: { api: Bound }) {
  const onAuthError = useOnAuthError()
  const [instances, setInstances] = useState<Instance[] | null>(null)
  const [countsError, setCountsError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Pick | null>(null)
  const [lines, setLines] = useState<ChatMessage[]>([])
  const [status, setStatus] = useState<'live' | 'error' | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<number | null>(null)

  const countsGen = useRef(0)
  const loadCounts = useCallback(async () => {
    const mine = ++countsGen.current
    try {
      const rows = await api.roomCounts()
      if (mine !== countsGen.current) return
      setInstances(rows)
      setCountsError(null)
    } catch (e) {
      onAuthError(e)
      if (mine !== countsGen.current) return
      setCountsError(errorText(e instanceof ApiError ? e.code : 'unknown'))
    }
  }, [api, onAuthError])

  useEffect(() => {
    void loadCounts()
    const t = setInterval(() => void loadCounts(), REFRESH_MS)
    return () => {
      clearInterval(t)
      countsGen.current++
    }
  }, [loadCounts])

  const room = selected?.room
  const instance = selected?.instance
  useEffect(() => {
    setLines([])
    setStatus(null)
    setLoadError(null)
    setOpenId(null)
    if (room === undefined || instance === undefined) return
    let alive = true
    let unsub: (() => void) | undefined
    api.recentMessages(room, instance, 100).then(
      (rows) => {
        if (!alive) return
        setLines(rows.slice(-MAX_LINES))
        unsub = api.watchRoom(room, instance, {
          message: (m) => {
            if (!alive) return
            setLines((cur) => (cur.some((l) => l.id === m.id) ? cur : [...cur, m].slice(-MAX_LINES)))
          },
          deleted: (id) => {
            if (alive) setLines((cur) => cur.filter((l) => l.id !== id))
          },
          status: (s) => {
            if (alive) setStatus(s)
          },
        })
      },
      (e: unknown) => {
        onAuthError(e)
        if (alive) setLoadError(errorText(e instanceof ApiError ? e.code : 'unknown'))
      },
    )
    return () => {
      alive = false
      unsub?.()
    }
  }, [api, room, instance, onAuthError])

  return (
    <section aria-label="Live">
      <p className="muted">You are watching silently; people in the room don't see you.</p>
      <div className="actions-buttons">
        {instances?.map((i) => {
          const active = selected?.room === i.room && selected.instance === i.instance
          return (
            <button
              key={`${i.room}:${i.instance}`}
              type="button"
              aria-pressed={active}
              onClick={() => setSelected({ room: i.room, instance: i.instance })}
            >
              {`${i.room} · ${i.instance} — ${i.here} here`}
            </button>
          )
        })}
        <button type="button" onClick={() => void loadCounts()}>
          Refresh
        </button>
      </div>
      {countsError && <p role="alert">{countsError}</p>}
      {instances === null && !countsError && <p>Loading…</p>}
      {instances?.length === 0 && <p className="muted">Nobody is on a break right now.</p>}
      {selected && (
        <>
          <p>
            {`${selected.room} · ${selected.instance}`}{' '}
            {status && <span className="chip">{status === 'live' ? 'live' : 'connection problem'}</span>}
          </p>
          {loadError && <p role="alert">{loadError}</p>}
          <ul className="reports">
            {lines.map((l) => (
              <li key={l.id}>
                <strong style={{ color: nickColor(l.nickname) }}>{l.nickname}</strong>
                {': '}
                <span className="snap-body">{l.body}</span>{' '}
                <button type="button" onClick={() => setOpenId(openId === l.id ? null : l.id)}>
                  ⋯
                </button>
                {openId === l.id && (
                  <ActionBar
                    target={{ userId: l.user_id ?? '', nickname: l.nickname }}
                    messageId={l.id}
                    actions={l.user_id === null ? ['delete'] : ['delete', 'mute', 'ban']}
                    api={api}
                    onDone={() => setOpenId(null)}
                  />
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
