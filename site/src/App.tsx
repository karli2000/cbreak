import type { SupabaseClient } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import type { Bound, Me } from './api.ts'
import { AuthProvider, useAuth, useOnAuthError } from './auth.tsx'
import { COPY, errorText } from './copy.ts'
import { TABS, tabFromHash, type Tab } from './nav.ts'

export function App({ client, api }: { client: SupabaseClient; api: Bound }) {
  return (
    <AuthProvider client={client}>
      <Gate api={api} />
    </AuthProvider>
  )
}

type MeState = { status: 'loading' } | { status: 'none' } | { status: 'error'; code: string } | { status: 'ok'; me: Me }

function Gate({ api }: { api: Bound }) {
  const { client, session, loading, signOut } = useAuth()
  const onAuthError = useOnAuthError()
  const [state, setState] = useState<MeState>({ status: 'loading' })
  const userId = session?.user.id

  useEffect(() => {
    if (!userId) return
    let alive = true
    setState({ status: 'loading' })
    api.me().then(
      (me) => {
        if (alive) setState(me ? { status: 'ok', me } : { status: 'none' })
      },
      (e: unknown) => {
        onAuthError(e)
        if (alive) setState({ status: 'error', code: e instanceof Error && 'code' in e ? String(e.code) : 'unknown' })
      },
    )
    return () => {
      alive = false
    }
  }, [api, userId, onAuthError])

  if (loading) return <p className="center">Loading…</p>

  if (!session) {
    const signIn = () =>
      void client.auth.signInWithOAuth({
        provider: 'github',
        options: { redirectTo: window.location.origin + window.location.pathname },
      })
    return (
      <main className="center">
        <h1>☕ Coffee Break moderation</h1>
        <button onClick={signIn}>{COPY.signIn}</button>
      </main>
    )
  }

  const signOutButton = <button onClick={() => void signOut()}>{COPY.signOut}</button>

  if (state.status === 'loading') return <p className="center">Loading…</p>
  if (state.status === 'error')
    return (
      <main className="center">
        <p role="alert">{errorText(state.code)}</p>
        {signOutButton}
      </main>
    )
  if (state.status === 'none' || state.me.role === 'user')
    return (
      <main className="center">
        <p>{COPY.notModerator}</p>
        {signOutButton}
      </main>
    )
  if (state.me.banned)
    return (
      <main className="center">
        <p>{COPY.banned}</p>
        {signOutButton}
      </main>
    )
  return <Shell me={state.me} api={api} signOutButton={signOutButton} />
}

function useHash(): string {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const on = () => setHash(window.location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return hash
}

function Shell({ me, api, signOutButton }: { me: Me; api: Bound; signOutButton: React.ReactNode }) {
  const active = tabFromHash(useHash(), me.role)
  const tabs = TABS.filter((t) => t.tab !== 'admin' || me.role === 'admin')
  return (
    <>
      <header className="bar">
        <h1>
          ☕ Coffee Break moderation · {me.nickname} ({me.role})
        </h1>
        {signOutButton}
      </header>
      <nav aria-label="Sections" className="tabs">
        {tabs.map((t) => (
          <a key={t.tab} href={`#${t.tab}`} aria-current={t.tab === active ? 'page' : undefined}>
            {t.label}
          </a>
        ))}
      </nav>
      <main>
        <Screen tab={active} api={api} />
      </main>
    </>
  )
}

function Screen({ tab, api }: { tab: Tab; api: Bound }) {
  switch (tab) {
    case 'reports':
      return <ReportsPlaceholder api={api} />
    case 'live':
      return <section aria-label="Live">Live</section>
    case 'users':
      return <section aria-label="Users">Users</section>
    case 'bans':
      return <section aria-label="Bans">Bans</section>
    case 'audit':
      return <section aria-label="Audit">Audit</section>
    case 'admin':
      return <section aria-label="Admin">Admin</section>
  }
}

// Replaced in Task 4; the single initial call shows how screens route errors through useOnAuthError.
function ReportsPlaceholder({ api }: { api: Bound }) {
  const onAuthError = useOnAuthError()
  useEffect(() => {
    api.listReports('open').catch(onAuthError)
  }, [api, onAuthError])
  return <section aria-label="Reports">Reports</section>
}
