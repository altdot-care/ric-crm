import type { APIRoute } from 'astro';
import { json, fail, parseBody, dbError } from '@/lib/api';
import { leadCreate } from '@/lib/schemas';

export const prerender = false;

const COLUMNS =
  '*, company:companies!company_id(name), primary_contact:contacts!primary_contact_id(full_name, position), owner:profiles!owner_id(full_name)';

export const GET: APIRoute = async ({ locals }) => {
  const { data, error } = await locals.supabase
    .from('leads')
    .select(COLUMNS)
    .order('created_at', { ascending: false });
  if (error) return dbError(error);
  return json(data);
};

export const POST: APIRoute = async ({ locals, request }) => {
  const body = await parseBody(request, leadCreate);
  if (body instanceof Response) return body;

  if (body.primary_contact_id) {
    const { data: contact, error: contactError } = await locals.supabase
      .from('contacts')
      .select('id')
      .eq('id', body.primary_contact_id)
      .eq('company_id', body.company_id)
      .maybeSingle();
    if (contactError) return dbError(contactError);
    if (!contact) return fail('primary_contact_id does not belong to company_id', 400);
  }

  const { data, error } = await locals.supabase.from('leads').insert(body).select(COLUMNS).single();
  if (error) return dbError(error);
  return json(data, 201);
};
