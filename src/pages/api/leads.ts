import type { APIRoute } from 'astro';
import { json, parseBody, dbError } from '@/lib/api';
import { leadCreate } from '@/lib/schemas';

export const prerender = false;

const COLUMNS = '*, owner:profiles!owner_id(full_name)';

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

  const { data, error } = await locals.supabase.from('leads').insert(body).select(COLUMNS).single();
  if (error) return dbError(error);
  return json(data, 201);
};
