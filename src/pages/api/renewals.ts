import type { APIRoute } from 'astro';
import { json, parseBody, dbError } from '@/lib/api';
import { renewalCreate } from '@/lib/schemas';

export const prerender = false;

const COLUMNS = '*, company:companies!company_id(name), owner:profiles!owner_id(full_name)';

export const GET: APIRoute = async ({ locals }) => {
  const { data, error } = await locals.supabase
    .from('renewals')
    .select(COLUMNS)
    .order('expiry', { ascending: true });
  if (error) return dbError(error);
  return json(data);
};

export const POST: APIRoute = async ({ locals, request }) => {
  const body = await parseBody(request, renewalCreate);
  if (body instanceof Response) return body;

  const { data, error } = await locals.supabase.from('renewals').insert(body).select(COLUMNS).single();
  if (error) return dbError(error);
  return json(data, 201);
};
