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

  // The primary_contact_id ∈ company_id invariant must be re-checked whenever *either* field is
  // present in this request — not just when primary_contact_id is, otherwise `PUT
  // {"company_id": "<other-co>"}` alone silently moves the deal while leaving
  // primary_contact_id pointing at the old company's contact.
  if (body.primary_contact_id || body.company_id !== undefined) {
    let existing: { company_id: string; primary_contact_id: string | null } | null = null;
    if (body.company_id === undefined || body.primary_contact_id === undefined) {
      const { data, error: fetchError } = await locals.supabase
        .from('leads')
        .select('company_id, primary_contact_id')
        .eq('id', id.data)
        .maybeSingle();
      if (fetchError) return dbError(fetchError);
      if (!data) return fail('Not found', 404);
      existing = data;
    }

    const companyId = body.company_id ?? existing!.company_id;
    const contactProvided = body.primary_contact_id !== undefined;
    // The row's effective contact after this update: what the body sends, or, if the body
    // doesn't touch it, whatever the lead already has.
    const contactId = contactProvided ? body.primary_contact_id : existing!.primary_contact_id;

    if (contactId) {
      const { data: contact, error: contactError } = await locals.supabase
        .from('contacts')
        .select('id')
        .eq('id', contactId)
        .eq('company_id', companyId)
        .maybeSingle();
      if (contactError) return dbError(contactError);
      if (!contact) {
        if (contactProvided) return fail('primary_contact_id does not belong to company_id', 400);
        // The client only changed company_id; the lead's existing primary_contact_id no
        // longer belongs to the new company, so clear it instead of leaving a stale reference.
        body.primary_contact_id = null;
      }
    }
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
