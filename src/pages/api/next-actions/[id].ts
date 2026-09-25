import type { APIRoute } from 'astro';
import { json, fail, parseBody, dbError } from '@/lib/api';
import { requireRoot } from '@/lib/auth';
import { nextActionUpdate, uuidParam } from '@/lib/schemas';

export const prerender = false;

export const PUT: APIRoute = async ({ locals, request, params }) => {
  const id = uuidParam.safeParse(params.id);
  if (!id.success) return fail('Invalid id', 400);

  const body = await parseBody(request, nextActionUpdate);
  if (body instanceof Response) return body;
  if (Object.keys(body).length === 0) return fail('Nothing to update', 400);

  // "completed" is a boolean on the wire; translate to a server-set timestamp so the client
  // can never forge a specific completion time.
  const { completed, ...rest } = body;
  const update = { ...rest, ...(completed !== undefined && { completed_at: completed ? new Date().toISOString() : null }) };

  const { data, error } = await locals.supabase.from('next_actions').update(update).eq('id', id.data).select('id');
  if (error) return dbError(error);
  if (data.length === 0) return fail('Not found', 404);
  return json({ ok: true });
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  // RLS only lets root delete, but answer 403 (not a misleading 404) for everyone else.
  const denied = await requireRoot(locals);
  if (denied) return denied;

  const id = uuidParam.safeParse(params.id);
  if (!id.success) return fail('Invalid id', 400);

  const { data, error } = await locals.supabase.from('next_actions').delete().eq('id', id.data).select('id');
  if (error) return dbError(error);
  if (data.length === 0) return fail('Not found', 404);
  return json({ ok: true });
};
