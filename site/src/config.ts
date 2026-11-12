import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../../plugin/shared/backend.ts'

export const config: { url: string; anonKey: string } = {
  url: import.meta.env.VITE_SUPABASE_URL ?? SUPABASE_URL,
  anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? SUPABASE_ANON_KEY,
}
