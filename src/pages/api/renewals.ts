import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ locals }) => {
  const db = locals.DB;
  const { results } = await db.prepare('SELECT * FROM renewals ORDER BY expiry ASC').all();
  return new Response(JSON.stringify(results), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = async ({ locals, request }) => {
  const db = locals.DB;
  const body = await request.json() as any;
  const now = Date.now();
  const id = body.id || `ren_${now}_${Math.random().toString(36).slice(2, 7)}`;

  await db.prepare(`
    INSERT INTO renewals (id, company, cert, expiry, owner, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    body.company ?? '',
    body.cert ?? '',
    body.expiry ?? '',
    body.owner ?? '',
    now,
  ).run();

  return new Response(JSON.stringify({ id }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
};
