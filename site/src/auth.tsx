import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { ApiError } from './api.ts'

type AuthCtx = { client: SupabaseClient; session: Session | null; loading: boolean; signOut: () => Promise<void> }
const Ctx = createContext<AuthCtx | null>(null)

export function AuthProvider({ client, children }: { client: SupabaseClient; children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    client.auth.getSession().then(
      ({ data }) => {
        if (!alive) return
        setSession(data.session)
        setLoading(false)
      },
      () => {
        if (alive) setLoading(false)
      },
    )
    const { data } = client.auth.onAuthStateChange((_event, s) => {
      if (alive) setSession(s)
    })
    return () => {
      alive = false
      data.subscription.unsubscribe()
    }
  }, [client])

  const signOut = useCallback(async () => {
    try {
      await client.auth.signOut()
    } catch {
      // the local session is dropped below regardless
    }
    setSession(null)
  }, [client])

  return <Ctx.Provider value={{ client, session, loading, signOut }}>{children}</Ctx.Provider>
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth outside AuthProvider')
  return v
}

/** Returns a handler for caught api errors: an ended session signs out and returns to sign-in. */
export function useOnAuthError(): (e: unknown) => void {
  const { signOut } = useAuth()
  return useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.code === 'not_authenticated') void signOut()
    },
    [signOut],
  )
}
