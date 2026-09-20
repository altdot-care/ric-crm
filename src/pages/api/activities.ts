import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ locals }) => {
  const db = locals.DB;
  const { results } = await db.prepare('SELECT * FROM activities ORDER BY created_at DESC').all();
  return new Response(JSON.stringify(results), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = async ({ locals, request }) => {
  const db = locals.DB;
  const body = await request.json() as any;
  const now = Date.now();
  const id = body.id || `act_${now}_${Math.random().toString(36).slice(2, 7)}`;

  await db.prepare(`
    INSERT INTO activities (id, type, company, description, date, followup, by_user, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    body.type ?? 'note',
    body.company ?? '',
    body.description ?? '',
    body.date ?? new Date().toISOString().slice(0, 10),
    body.followup ?? '',
    body.by_user ?? '',
    now,
  ).run();

  return new Response(JSON.stringify({ id }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
};
