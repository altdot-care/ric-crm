import type { APIRoute } from 'astro';
import { json, dbError } from '@/lib/api';
import { requireRoot } from '@/lib/auth';
import { endpointHost } from '@/lib/push-endpoint';

export const prerender = false;

// The signed-in root's own registered devices (RLS already limits rows to the owner).
// Only the endpoint's host is returned — never the full endpoint or any encryption key.
export const GET: APIRoute = async ({ locals }) => {
  const denied = await requireRoot(locals);
  if (denied) return denied;
  const { data, error } = await locals.supabase.from('push_subscriptions')
    .select('id, endpoint, created_at').order('created_at', { ascending: false });
  if (error) return dbError(error);
  return json(data.map(row => ({ id: row.id, host: endpointHost(row.endpoint) ?? 'ไม่ทราบ (endpoint ไม่ถูกต้อง)', created_at: row.created_at })));
};
