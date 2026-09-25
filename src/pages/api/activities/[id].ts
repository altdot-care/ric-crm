import type { APIRoute } from 'astro';
import { json, fail, parseBody, dbError } from '@/lib/api';
import { activityUpdate, uuidParam } from '@/lib/schemas';
import { COLUMNS } from '../activities.ts';

export const prerender = false;

// RLS decides who may change a log entry: its owner or an admin, never a stage_change row.
// Anything RLS hides comes back as zero rows, which is answered 404.
export const PUT: APIRoute = async ({ locals, request, params }) => {
  const id = uuidParam.safeParse(params.id);
  if (!id.success) return fail('Invalid id', 400);

  const body = await parseBody(request, activityUpdate);
  if (body instanceof Response) return body;
  if (Object.keys(body).length === 0) return fail('Nothing to update', 400);

  const { followup, ...rest } = body;
  const { data, error } = await locals.supabase
    .from('activities')
    .update({ ...rest, ...(followup !== undefined && { followup: followup || null }) })
    .eq('id', id.data)
    .select(COLUMNS);
  if (error) return dbError(error);
  if (data.length === 0) return fail('Not found', 404);
  return json(data[0]);
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  const id = uuidParam.safeParse(params.id);
  if (!id.success) return fail('Invalid id', 400);

  const { data, error } = await locals.supabase.from('activities').delete().eq('id', id.data).select('id');
  if (error) return dbError(error);
  if (data.length === 0) return fail('Not found', 404);
  return json({ ok: true });
};
