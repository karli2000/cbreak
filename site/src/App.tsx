import type { SupabaseClient } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'
import { ApiError, type Bound, type Me, type Role } from './api.ts'
import { AuthProvider, useAuth, useOnAuthError } from './auth.tsx'
import { COPY, errorText } from './copy.ts'
import { Live } from './screens/Live.tsx'
import { Admin } from './screens/Admin.tsx'
import { Audit } from './screens/Audit.tsx'
import { Bans } from './screens/Bans.tsx'
import { Reports } from './screens/Reports.tsx'
import { Users } from './screens/Users.tsx'
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
        <Screen tab={active} api={api} role={me.role} />
      </main>
    </>
  )
}

function Screen({ tab, api, role }: { tab: Tab; api: Bound; role: Role }) {
  switch (tab) {
    case 'reports':
      return <Reports api={api} />
    case 'live':
      return <Live api={api} />
    case 'users':
      return <Users api={api} role={role} />
    case 'bans':
      return <Bans api={api} role={role} />
    case 'audit':
      return <Audit api={api} />
    case 'admin':
      return <Admin api={api} />
  }
}
