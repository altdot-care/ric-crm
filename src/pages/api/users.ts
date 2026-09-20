import type { APIRoute } from 'astro';
import { json, fail, parseBody, dbError } from '@/lib/api';
import { requireRoot } from '@/lib/auth';
import { userCreate } from '@/lib/schemas';
import { createAdminClient } from '@/lib/supabase-admin';

export const prerender = false;

const NOT_CONFIGURED = 'User management is not configured (SUPABASE_SECRET_KEY is missing)';

/** All users with their email (emails live in auth.users, which only the service-role key can list). */
export const GET: APIRoute = async ({ locals }) => {
  const denied = await requireRoot(locals);
  if (denied) return denied;
  const admin = createAdminClient();
  if (!admin) return fail(NOT_CONFIGURED, 503);

  const [{ data: profiles, error }, { data: authData, error: authError }] = await Promise.all([
    locals.supabase.from('profiles').select('id, full_name, role, created_at').order('created_at'),
    admin.auth.admin.listUsers({ perPage: 1000 }),
  ]);
  if (error) return dbError(error);
  if (authError) return dbError(authError);

  const emails = new Map(authData.users.map((u) => [u.id, u.email ?? '']));
  return json(profiles.map((p) => ({ ...p, email: emails.get(p.id) ?? '' })));
};

export const POST: APIRoute = async ({ locals, request }) => {
  const denied = await requireRoot(locals);
  if (denied) return denied;
  const admin = createAdminClient();
  if (!admin) return fail(NOT_CONFIGURED, 503);

  const body = await parseBody(request, userCreate);
  if (body instanceof Response) return body;

  const { data: created, error } = await admin.auth.admin.createUser({
    email: body.email,
    password: body.password,
    email_confirm: true,
    user_metadata: { full_name: body.full_name },
  });
  if (error || !created.user) {
    if (error?.code === 'email_exists') return fail('Email already registered', 409);
    if (error?.code === 'weak_password') return fail('Password is too weak', 400);
    return dbError(error ?? { message: 'createUser returned no user' });
  }

  // The on_auth_user_created trigger made a 'sales' profile; raise it if admin was requested.
  if (body.role !== 'sales') {
    const { error: roleError } = await admin.from('profiles').update({ role: body.role }).eq('id', created.user.id);
    if (roleError) {
      await admin.auth.admin.deleteUser(created.user.id); // don't leave a half-configured account behind
      return dbError(roleError);
    }
  }

  return json({ id: created.user.id, email: body.email, full_name: body.full_name, role: body.role }, 201);
};
