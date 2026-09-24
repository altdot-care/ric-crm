import type { APIRoute } from 'astro';
import { json, fail, parseBody, dbError } from '@/lib/api';
import { requireRoot } from '@/lib/auth';
import { leadUpdate, uuidParam } from '@/lib/schemas';

export const prerender = false;

export const PUT: APIRoute = async ({ locals, request, params }) => {
  const id = uuidParam.safeParse(params.id);
  if (!id.success) return fail('Invalid id', 400);

  const body = await parseBody(request, leadUpdate);
  if (body instanceof Response) return body;
  if (Object.keys(body).length === 0) return fail('Nothing to update', 400);

  if (body.primary_contact_id) {
    let companyId = body.company_id;
    if (!companyId) {
      const { data: existing, error: fetchError } = await locals.supabase
        .from('leads')
        .select('company_id')
        .eq('id', id.data)
        .maybeSingle();
      if (fetchError) return dbError(fetchError);
      if (!existing) return fail('Not found', 404);
      companyId = existing.company_id;
    }
    const { data: contact, error: contactError } = await locals.supabase
      .from('contacts')
      .select('id')
      .eq('id', body.primary_contact_id)
      .eq('company_id', companyId)
      .maybeSingle();
    if (contactError) return dbError(contactError);
    if (!contact) return fail('primary_contact_id does not belong to company_id', 400);
  }

  // RLS filters rows the user doesn't own, so "no row" means not found or not allowed.
  const { data, error } = await locals.supabase
    .from('leads')
    .update(body)
    .eq('id', id.data)
    .select('id');
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

  const { data, error } = await locals.supabase.from('leads').delete().eq('id', id.data).select('id');
  if (error) return dbError(error);
  if (data.length === 0) return fail('Not found', 404);
  return json({ ok: true });
};
