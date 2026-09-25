import type { APIRoute } from 'astro';
import { json, fail, parseBody, dbError } from '@/lib/api';
import { nextActionCreate, uuidParam } from '@/lib/schemas';

export const prerender = false;

export const GET: APIRoute = async ({ locals, url }) => {
  let query = locals.supabase.from('next_actions').select('*').order('due_date', { ascending: true, nullsFirst: false });
  const leadId = url.searchParams.get('lead_id');
  if (leadId) {
    const parsed = uuidParam.safeParse(leadId);
    if (!parsed.success) return fail('Invalid lead_id', 400);
    query = query.eq('lead_id', parsed.data);
  }
  const { data, error } = await query;
  if (error) return dbError(error);
  return json(data);
};

export const POST: APIRoute = async ({ locals, request }) => {
  const body = await parseBody(request, nextActionCreate);
  if (body instanceof Response) return body;

  const { data, error } = await locals.supabase.from('next_actions').insert(body).select('*').single();
  if (error) return dbError(error);
  return json(data, 201);
};
