import type { APIRoute } from 'astro';
import { json, fail, dbError } from '@/lib/api';
import { uuidParam } from '@/lib/schemas';

export const prerender = false;

export const DELETE: APIRoute = async ({ locals, params }) => {
  const id = uuidParam.safeParse(params.id);
  if (!id.success) return fail('Invalid id', 400);

  const { data, error } = await locals.supabase.from('renewals').delete().eq('id', id.data).select('id');
  if (error) return dbError(error);
  if (data.length === 0) return fail('Not found', 404);
  return json({ ok: true });
};
