import type { APIRoute } from 'astro';
import { json, fail, parseBody, dbError } from '@/lib/api';
import { requireRoot } from '@/lib/auth';
import { contactUpdate, uuidParam } from '@/lib/schemas';

export const prerender = false;

export const PUT: APIRoute = async ({ locals, request, params }) => {
  const id = uuidParam.safeParse(params.id);
  if (!id.success) return fail('Invalid id', 400);

  const body = await parseBody(request, contactUpdate);
  if (body instanceof Response) return body;
  if (Object.keys(body).length === 0) return fail('Nothing to update', 400);

  const { data, error } = await locals.supabase.from('contacts').update(body).eq('id', id.data).select('id');
  if (error) return dbError(error);
  if (data.length === 0) return fail('Not found', 404);
  return json({ ok: true });
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  // RLS only lets root delete, but answer 403 (not a misleading 404) for everyone else.
  // Any lead whose primary_contact_id pointed here just has it set to null (ON DELETE SET NULL) —
  // deleting a contact never blocks or destroys a deal.
  const denied = await requireRoot(locals);
  if (denied) return denied;

  const id = uuidParam.safeParse(params.id);
  if (!id.success) return fail('Invalid id', 400);

  const { data, error } = await locals.supabase.from('contacts').delete().eq('id', id.data).select('id');
  if (error) return dbError(error);
  if (data.length === 0) return fail('Not found', 404);
  return json({ ok: true });
};
