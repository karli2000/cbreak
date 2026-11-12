import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config } from './config.ts'

export function createSiteClient(): SupabaseClient {
  return createClient(config.url, config.anonKey, {
    auth: {
      flowType: 'pkce',
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true,
    },
  })
}
