import type { SupabaseClient } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import { ApiError, type Bound, type Me } from './api.ts'
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

type MeResult = { status: 'none' } | { status: 'error'; code: string } | { status: 'ok'; me: Me }
type MeState = MeResult & { uid: string }

function Gate({ api }: { api: Bound }) {
  const { client, session, loading, signOut } = useAuth()
  const onAuthError = useOnAuthError()
  const [loaded, setLoaded] = useState<MeState | null>(null)
  const [signInError, setSignInError] = useState<string | null>(null)
  const userId = session?.user.id
  // A result for another user counts as still loading, so an old Shell never shows for a new user.
  const state: { status: 'loading' } | MeResult = loaded && loaded.uid === userId ? loaded : { status: 'loading' }

  useEffect(() => {
    if (!userId) return
    let alive = true
    api.me().then(
      (me) => {
        if (alive) setLoaded(me ? { uid: userId, status: 'ok', me } : { uid: userId, status: 'none' })
      },
      (e: unknown) => {
        onAuthError(e)
        if (alive) setLoaded({ uid: userId, status: 'error', code: e instanceof ApiError ? e.code : 'unknown' })
      },
    )
    return () => {
      alive = false
    }
  }, [api, userId, onAuthError])

  if (loading) return <p className="center">Loading…</p>

  if (!session) {
    const signIn = async () => {
      setSignInError(null)
      try {
        const { error } = await client.auth.signInWithOAuth({
          provider: 'github',
          options: { redirectTo: window.location.origin + window.location.pathname },
        })
        if (error) setSignInError(errorText(error.message && /^[a-z_]+$/.test(error.message) ? error.message : 'unknown'))
      } catch {
        setSignInError(errorText('network'))
      }
    }
    return (
      <main className="center">
        <h1>☕ Coffee Break moderation</h1>
        <button onClick={() => void signIn()}>{COPY.signIn}</button>
        {signInError && <p role="alert">{signInError}</p>}
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
