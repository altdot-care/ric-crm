import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ locals }) => {
  const db = locals.DB;
  const { results } = await db.prepare('SELECT * FROM leads ORDER BY created_at DESC').all();
  return new Response(JSON.stringify(results), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = async ({ locals, request }) => {
  const db = locals.DB;
  const body = await request.json() as any;
  const now = Date.now();
  const id = body.id || `lead_${now}_${Math.random().toString(36).slice(2, 7)}`;

  await db.prepare(`
    INSERT INTO leads (id, company, contact, phone, email, cert, stage, value, assigned, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    body.company ?? '',
    body.contact ?? '',
    body.phone ?? '',
    body.email ?? '',
    body.cert ?? '',
    body.stage ?? 'new',
    body.value ?? 0,
    body.assigned ?? '',
    body.notes ?? '',
    now,
    now,
  ).run();

  return new Response(JSON.stringify({ id }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
};
