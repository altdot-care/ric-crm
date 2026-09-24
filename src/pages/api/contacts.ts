import type { APIRoute } from 'astro';
import { json, fail, parseBody, dbError } from '@/lib/api';
import { contactCreate, uuidParam } from '@/lib/schemas';

export const prerender = false;

export const GET: APIRoute = async ({ locals, url }) => {
  let query = locals.supabase.from('contacts').select('*').order('full_name');
  const companyId = url.searchParams.get('company_id');
  if (companyId) {
    const parsed = uuidParam.safeParse(companyId);
    if (!parsed.success) return fail('Invalid company_id', 400);
    query = query.eq('company_id', parsed.data);
  }
  const { data, error } = await query;
  if (error) return dbError(error);
  return json(data);
};

export const POST: APIRoute = async ({ locals, request }) => {
  const body = await parseBody(request, contactCreate);
  if (body instanceof Response) return body;

  const { data, error } = await locals.supabase.from('contacts').insert(body).select('*').single();
  if (error) return dbError(error);
  return json(data, 201);
};
