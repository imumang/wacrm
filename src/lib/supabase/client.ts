import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getBrowserSupabaseUrl, getSupabaseAuthCookieName } from './config'

// Singleton instance — one client shared across the whole browser session.
// Creating multiple clients causes auth-lock contention ("Lock was released
// because another request stole it") and intermittent fetch failures.
let browserClient: SupabaseClient | undefined

export function createClient() {
  if (browserClient) return browserClient

  browserClient = createBrowserClient(
    getBrowserSupabaseUrl(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    // Preserve the pre-proxy cookie name so existing localhost sessions keep
    // working and the browser and SSR clients can share one session.
    { cookieOptions: { name: getSupabaseAuthCookieName() } }
  )

  return browserClient
}
