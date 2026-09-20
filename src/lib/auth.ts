import { fail, dbError } from '@/lib/api';

/**
 * Root-only guard. Reads the caller's role from the database (as the caller, under RLS) rather than
 * trusting anything the client sent. Returns a ready-to-return Response when access is denied, else null.
 */
export async function requireRoot(locals: App.Locals): Promise<Response | null> {
  const { data, error } = await locals.supabase
    .from('profiles')
    .select('role')
    .eq('id', locals.user!.id)
    .maybeSingle();
  if (error) return dbError(error);
  return data?.role === 'root' ? null : fail('Forbidden', 403);
}
