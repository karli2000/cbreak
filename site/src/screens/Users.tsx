import { useRef, useState } from 'react'
import { nickColor } from '../../../plugin/hooks/lib/format.ts'
import { ApiError, type Bound, type Role, type UserLookup } from '../api.ts'
import { useOnAuthError } from '../auth.tsx'
import { errorText } from '../copy.ts'
import { ActionBar } from '../components/ActionBar.tsx'
import { Snapshot } from '../components/Snapshot.tsx'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')

/** "14:05, 12 Nov" in local time. */
function stamp(iso: string): string {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}, ${d.getDate()} ${MONTHS[d.getMonth()]}`
}

function muteText(until: string | null): string {
  return until !== null && new Date(until).getTime() > Date.now() ? `Muted until ${stamp(until)}` : 'Not muted'
}

function githubAge(iso: string | null): string {
  return iso === null ? 'unknown → slow mode' : new Date(iso).toLocaleDateString()
}

type Result = { status: 'found'; data: UserLookup; actors: Map<string, { nickname: string; role: Role }> | null; namesError: string | null } | { status: 'missing' } | { status: 'error'; text: string }

export function Users({ api, role }: { api: Bound; role: Role }) {
  const onAuthError = useOnAuthError()
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const gen = useRef(0)

  async function run(nick: string) {
    const mine = ++gen.current
    try {
      const data = await api.lookupUser(nick)
      let namesError: string | null = null
      const actors = await api
        .names(data.actions_against.map((a) => a.actor_id).filter((x): x is string => x !== null))
        .catch((e: unknown) => {
          onAuthError(e)
          namesError = errorText(e instanceof ApiError ? e.code : 'unknown')
          return null
        })
      if (mine !== gen.current) return
      setResult({ status: 'found', data, actors, namesError })
    } catch (e) {
      onAuthError(e)
      if (mine !== gen.current) return
      const code = e instanceof ApiError ? e.code : 'unknown'
      setResult(code === 'not_found' ? { status: 'missing' } : { status: 'error', text: errorText(code) })
    }
  }

  function submit(ev: React.FormEvent) {
    ev.preventDefault()
    const nick = query.trim().toLowerCase().replace(/^@/, '')
    if (!nick) {
      gen.current++
      setResult({ status: 'error', text: 'Enter a nickname.' })
      return
    }
    void run(nick)
  }

  const found = result?.status === 'found' ? result : null
  const actions: ('mute' | 'unmute' | 'ban' | 'unban')[] = role === 'admin' ? ['mute', 'unmute', 'ban', 'unban'] : ['mute', 'unmute', 'ban']

  return (
    <section aria-label="Users">
      <form onSubmit={submit}>
        <label>
          Nickname <input value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>{' '}
        <button type="submit">
          Look up
        </button>
      </form>
      {result?.status === 'missing' && <p role="alert">No user with that nickname.</p>}
      {result?.status === 'error' && <p role="alert">{result.text}</p>}
      {found && (
        <>
          <Profile p={found.data.profile} />
          <ActionBar
            key={found.data.profile.id}
            target={{ userId: found.data.profile.id, nickname: found.data.profile.nickname }}
            actions={actions}
            api={api}
            onDone={() => void run(found.data.profile.nickname)}
          />
          <h3>Reports against them</h3>
          {found.data.reports_against.length === 0 && <p className="muted">None.</p>}
          <ul className="reports">
            {found.data.reports_against.map((r) => (
              <li key={r.id} className="report">
                <p className="snap-body">{r.reason}</p>
                <p className="muted">
                  {r.status} · <time dateTime={r.created_at}>{new Date(r.created_at).toLocaleString()}</time>
                </p>
                <details>
                  <summary>Snapshot</summary>
                  <Snapshot snapshot={r.snapshot} highlightId={r.message_id} />
                </details>
              </li>
            ))}
          </ul>
          <h3>Actions against them</h3>
          {found.namesError && <p role="alert">{found.namesError}</p>}
          {found.data.actions_against.length === 0 && <p className="muted">None.</p>}
          <ul className="reports">
            {found.data.actions_against.map((a) => (
              <li key={a.id} className="report">
                <p>
                  <strong>{a.action}</strong> by {a.actor_id ? (found.actors ? (found.actors.get(a.actor_id)?.nickname ?? 'deleted user') : 'unknown') : 'system'} ·{' '}
                  <time dateTime={a.created_at}>{new Date(a.created_at).toLocaleString()}</time>
                </p>
                {a.reason && <p className="snap-body">{a.reason}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function Profile({ p }: { p: UserLookup['profile'] }) {
  return (
    <div className="profile">
      <h2>
        <span style={{ color: nickColor(p.nickname) }}>{p.nickname}</span> ({p.role})
      </h2>
      <p>GitHub account: {githubAge(p.github_created_at)}</p>
      <p>Joined: {new Date(p.created_at).toLocaleDateString()}</p>
      <p>{muteText(p.muted_until)}</p>
      <p>{p.banned_at !== null ? `Banned: ${p.ban_reason ?? 'no reason given'}` : 'Not banned'}</p>
    </div>
  )
}
