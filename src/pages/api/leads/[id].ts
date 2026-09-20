import type { APIRoute } from 'astro';

export const PUT: APIRoute = async ({ locals, request, params }) => {
  const db = locals.DB;
  const id = params.id!;
  const body = await request.json() as any;
  const now = Date.now();

  await db.prepare(`
    UPDATE leads SET
      company = COALESCE(?, company),
      contact = COALESCE(?, contact),
      phone = COALESCE(?, phone),
      email = COALESCE(?, email),
      cert = COALESCE(?, cert),
      stage = COALESCE(?, stage),
      value = COALESCE(?, value),
      assigned = COALESCE(?, assigned),
      notes = COALESCE(?, notes),
      updated_at = ?
    WHERE id = ?
  `).bind(
    body.company ?? null,
    body.contact ?? null,
    body.phone ?? null,
    body.email ?? null,
    body.cert ?? null,
    body.stage ?? null,
    body.value ?? null,
    body.assigned ?? null,
    body.notes ?? null,
    now,
    id,
  ).run();

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  const db = locals.DB;
  const id = params.id!;

  await db.prepare('DELETE FROM leads WHERE id = ?').bind(id).run();

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
