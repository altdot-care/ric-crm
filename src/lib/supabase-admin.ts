import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_SECRET_KEY } from 'astro:env/server';

/**
 * Service-role client. It BYPASSES Row Level Security, so it is only for the root-only user-management
 * routes (src/pages/api/users), and each of them must call requireRoot() first.
 * Returns null when SUPABASE_SECRET_KEY is not configured.
 */
export function createAdminClient() {
  if (!SUPABASE_SECRET_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
