import type { APIRoute } from 'astro';
import { json, fail, parseBody, dbError } from '@/lib/api';
import { pushSubscriptionCreate } from '@/lib/schemas';

export const prerender = false;

export const GET: APIRoute = async ({ locals, url }) => {
  const endpoint = url.searchParams.get('endpoint');
  if (!endpoint) return fail('Missing endpoint', 400);
  const { data, error } = await locals.supabase.from('push_subscriptions')
    .select('id').eq('endpoint', endpoint).maybeSingle();
  if (error) return dbError(error);
  return json(data);
};

export const POST: APIRoute = async ({ locals, request }) => {
  const body = await parseBody(request, pushSubscriptionCreate);
  if (body instanceof Response) return body;
  const db = locals.supabase;
  const { data: existing, error: lookupError } = await db.from('push_subscriptions')
    .select('id, p256dh, auth').eq('endpoint', body.endpoint).maybeSingle();
  if (lookupError) return dbError(lookupError);
  if (existing) {
    if (existing.p256dh === body.p256dh && existing.auth === body.auth) return json({ id: existing.id }, 201);
    // Immutable owner-only rows have no UPDATE policy. Replace only the caller's own row.
    const { error } = await db.from('push_subscriptions').delete().eq('id', existing.id);
    if (error) return dbError(error);
  }
  const { data, error } = await db.from('push_subscriptions')
    .insert({ ...body, owner_id: locals.user!.id }).select('id').single();
  if (error?.code === '23505') return fail('Subscription already registered; please try again', 409);
  if (error) return dbError(error);
  return json(data, 201);
};

export const DELETE: APIRoute = async ({ locals, url }) => {
  const endpoint = url.searchParams.get('endpoint');
  if (!endpoint) return fail('Missing endpoint', 400);
  const { data, error } = await locals.supabase.from('push_subscriptions')
    .delete().eq('endpoint', endpoint).select('id');
  if (error) return dbError(error);
  if (!data.length) return fail('Not found', 404);
  return json({ ok: true });
};
