import type { APIRoute } from 'astro';
import { json, fail, parseBody, dbError } from '@/lib/api';
import { activityCreate, uuidParam } from '@/lib/schemas';

export const prerender = false;

const COLUMNS = '*, lead:leads!lead_id(company:companies!company_id(name)), owner:profiles!owner_id(full_name)';

export const GET: APIRoute = async ({ locals, url }) => {
  let query = locals.supabase.from('activities').select(COLUMNS).order('created_at', { ascending: false });
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
  const body = await parseBody(request, activityCreate);
  if (body instanceof Response) return body;

  const { followup, date, ...rest } = body;
  const { data, error } = await locals.supabase
    .from('activities')
    .insert({ ...rest, ...(date && { date }), followup: followup || null })
    .select(COLUMNS)
    .single();
  if (error) return dbError(error);
  return json(data, 201);
};
