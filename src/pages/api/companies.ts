import type { APIRoute } from 'astro';
import { json, parseBody, dbError } from '@/lib/api';
import { companyCreate } from '@/lib/schemas';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const { data, error } = await locals.supabase.from('companies').select('*').order('name');
  if (error) return dbError(error);
  return json(data);
};

export const POST: APIRoute = async ({ locals, request }) => {
  const body = await parseBody(request, companyCreate);
  if (body instanceof Response) return body;

  const { data, error } = await locals.supabase.from('companies').insert(body).select('*').single();
  if (error) return dbError(error);
  return json(data, 201);
};
