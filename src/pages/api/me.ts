import type { APIRoute } from 'astro';
import { json, fail, dbError } from '@/lib/api';

export const prerender = false;

/** Current user's profile plus the list of profiles (for owner pickers). */
export const GET: APIRoute = async ({ locals }) => {
  const { data, error } = await locals.supabase
    .from('profiles')
    .select('id, full_name, role')
    .order('full_name');
  if (error) return dbError(error);

  const me = data.find((p) => p.id === locals.user!.id);
  if (!me) return fail('Profile not found', 403);
  return json({ me, profiles: data });
};
