import type { APIRoute } from 'astro';
import { json, fail, parseBody, dbError } from '@/lib/api';
import { requireRoot } from '@/lib/auth';
import { userRoleUpdate, uuidParam } from '@/lib/schemas';
import { createAdminClient } from '@/lib/supabase-admin';

export const prerender = false;

/** Change a user's role (root only). The DB trigger also refuses root/self changes. */
export const PATCH: APIRoute = async ({ locals, request, params }) => {
  const denied = await requireRoot(locals);
  if (denied) return denied;

  const id = uuidParam.safeParse(params.id);
  if (!id.success) return fail('Invalid id', 400);
  if (id.data === locals.user!.id) return fail('You cannot change your own role', 400);

  const body = await parseBody(request, userRoleUpdate);
  if (body instanceof Response) return body;

  const { data: target, error: lookupError } = await locals.supabase
    .from('profiles').select('role').eq('id', id.data).maybeSingle();
  if (lookupError) return dbError(lookupError);
  if (!target) return fail('Not found', 404);
  if (target.role === 'root') return fail('Root cannot be modified', 400);

  const { error } = await locals.supabase.from('profiles').update({ role: body.role }).eq('id', id.data);
  if (error) return dbError(error);
  return json({ ok: true });
};

/** Delete a user (root only). Their leads/activities/renewals are handed to the root who deletes them. */
export const DELETE: APIRoute = async ({ locals, params }) => {
  const denied = await requireRoot(locals);
  if (denied) return denied;
  const admin = createAdminClient();
  if (!admin) return fail('User management is not configured (SUPABASE_SECRET_KEY is missing)', 503);

  const id = uuidParam.safeParse(params.id);
  if (!id.success) return fail('Invalid id', 400);
  if (id.data === locals.user!.id) return fail('You cannot delete yourself', 400);

  const { data: target, error: lookupError } = await locals.supabase
    .from('profiles').select('role').eq('id', id.data).maybeSingle();
  if (lookupError) return dbError(lookupError);
  if (!target) return fail('Not found', 404);
  if (target.role === 'root') return fail('Root cannot be deleted', 400);

  const { error: reassignError } = await admin.rpc('reassign_owner', { from_id: id.data, to_id: locals.user!.id });
  if (reassignError) return dbError(reassignError);

  const { error } = await admin.auth.admin.deleteUser(id.data);
  if (error) return dbError(error);
  return json({ ok: true });
};
