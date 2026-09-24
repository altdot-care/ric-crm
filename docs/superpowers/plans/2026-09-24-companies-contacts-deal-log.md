# Companies, Contacts, Deal Log & Next Action Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace free-text company/contact fields on `leads` with real `companies`/`contacts` tables (one company, many deals, many contacts with a role), and give each deal an automatic, un-editable stage-change log plus a "next action" reminder.

**Architecture:** Two Postgres migrations per phase (schema + RLS, matching every existing table's owner/admin/root pattern), new Zod schemas, four new API route files plus edits to the existing `leads`/`activities` routes, and UI changes inside the single `src/pages/index.astro` file (the codebase's established pattern — everything else already lives there).

**Tech Stack:** Astro + Cloudflare Workers, Supabase (Postgres + RLS), Zod, vanilla inline JS (no framework) — same stack as the rest of the app.

**Spec:** `docs/superpowers/specs/2026-09-24-companies-contacts-deal-log-design.md`

## Global Constraints

- The `leads` table keeps its name — every route, RLS policy, and test already refers to it; renaming buys nothing.
- New tables (`companies`, `contacts`) reuse the *exact* RLS policy shapes already used by `leads`/`activities`/`renewals`: `select` for all authenticated users (`using (true)`), `insert`/`update` for owner or admin (`is_admin()`), `delete` for root only (`is_root()`). No new SQL helper functions.
- No data migration is needed — there is no real company/lead data in production yet (confirmed). Only `seed.sql` needs rewriting.
- `renewals.company` stays free text — explicitly out of scope.
- `activityCreate`'s Zod `type` enum stays `call/email/meeting/note` — `stage_change` is added only to the database check constraint; only the trigger (running as `security definer`) ever writes it. This is the only enforcement boundary; there is no RLS-level block, matching how every other column in this app is validated at the API layer, not in RLS.
- `primary_contact_id` belonging to `company_id` is enforced in the API layer (a query before the write), not a database constraint — Postgres can't easily check "this FK's target row has a specific value in another column" declaratively.
- Every new/changed SQL file goes in `supabase/migrations/`, named `<timestamp>_<description>.sql`, applied locally with `supabase db reset` (see Task 1 for the exact command) — never hand-edit a migration that's already shipped to production.
- Every new/changed API route follows the existing shape exactly: `parseBody(request, schema)` → early-return on `Response`, `dbError(error)` on failure, `json(data, status)` on success. See `src/lib/api.ts` for these helpers — do not reimplement them.

---

## Phase 1 — Companies & Contacts

### Task 1: Migration — `companies` and `contacts` tables

**Files:**
- Create: `supabase/migrations/20260924000000_companies_contacts.sql`
- Test: `supabase/tests/companies_contacts.test.sql`

**Interfaces:**
- Produces: tables `public.companies (id, name, owner_id, created_at)` and `public.contacts (id, company_id, full_name, position, phone, email, gender, occupation, postcode, address1, address2, sub_district, district, province, status, owner_id, created_at)`. Later tasks reference these exact column names.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260924000000_companies_contacts.sql
-- Companies: a customer organisation. One company can have many deals (leads) over time.
create table public.companies (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) > 0),
  owner_id   uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now()
);

-- Contacts: a person at a company. Shared across all of that company's deals — not duplicated
-- per deal. Personal/address fields here were moved off `leads` (they describe a person, not a deal).
create table public.contacts (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete cascade,
  full_name    text not null check (length(btrim(full_name)) > 0),
  position     text not null default '', -- free text (QMR, จัดซื้อ, เจ้าของ, ...) — no fixed list
  phone        text not null default '',
  email        text not null default '',
  gender       text null,
  occupation   text null,
  postcode     text null,
  address1     text null,
  address2     text null,
  sub_district text null,
  district     text null,
  province     text null,
  status       smallint not null default '1'::smallint,
  owner_id     uuid not null default auth.uid() references public.profiles (id),
  created_at   timestamptz not null default now()
);

create index contacts_company_id_idx on public.contacts (company_id);
create index companies_owner_id_idx  on public.companies (owner_id);
create index contacts_owner_id_idx   on public.contacts (owner_id);

alter table public.companies enable row level security;
alter table public.contacts  enable row level security;

-- Same shape as every other table: everyone reads, owner/admin writes, root deletes.
create policy "companies_select" on public.companies
  for select to authenticated using (true);
create policy "companies_insert" on public.companies
  for insert to authenticated with check (owner_id = (select auth.uid()) or (select public.is_admin()));
create policy "companies_update" on public.companies
  for update to authenticated
  using (owner_id = (select auth.uid()) or (select public.is_admin()))
  with check (owner_id = (select auth.uid()) or (select public.is_admin()));
create policy "companies_delete" on public.companies
  for delete to authenticated using ((select public.is_root()));

create policy "contacts_select" on public.contacts
  for select to authenticated using (true);
create policy "contacts_insert" on public.contacts
  for insert to authenticated with check (owner_id = (select auth.uid()) or (select public.is_admin()));
create policy "contacts_update" on public.contacts
  for update to authenticated
  using (owner_id = (select auth.uid()) or (select public.is_admin()))
  with check (owner_id = (select auth.uid()) or (select public.is_admin()));
create policy "contacts_delete" on public.contacts
  for delete to authenticated using ((select public.is_root()));
```

- [ ] **Step 2: Apply it locally**

Run: `cd supabase && supabase db reset`
Expected: output lists `Applying migration 20260924000000_companies_contacts.sql...` with no error, ends with `Finished supabase db reset on branch main.`

- [ ] **Step 3: Write the RLS test**

Follow the exact pattern of `supabase/tests/roles.test.sql` (fixture users via `pg_temp.as_user`/`pg_temp.expect`, wrapped in `begin; ... rollback;`). Reuse the same four fixture users this file creates, so run it inside the same transaction style but with its own fixtures (it must be runnable standalone):

```sql
-- supabase/tests/companies_contacts.test.sql
-- Run: docker exec -i supabase_db_Workspaces psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/companies_contacts.test.sql
begin;

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                        confirmation_token, recovery_token, email_change, email_change_token_new)
select '00000000-0000-0000-0000-000000000000', v.id, 'authenticated', 'authenticated', v.email, '', now(),
       '{}', '{}', now(), now(), '', '', '', ''
from (values
  ('cccccccc-0000-4000-8000-000000000a'::uuid, 'test-root2@example.test'),
  ('cccccccc-0000-4000-8000-000000000b'::uuid, 'test-admin2@example.test'),
  ('cccccccc-0000-4000-8000-000000000c'::uuid, 'test-sales3@example.test'),
  ('cccccccc-0000-4000-8000-000000000d'::uuid, 'test-sales4@example.test')
) as v(id, email);

update public.profiles set role = 'root'  where id = 'cccccccc-0000-4000-8000-000000000a';
update public.profiles set role = 'admin' where id = 'cccccccc-0000-4000-8000-000000000b';

insert into public.companies (id, name, owner_id) values
  ('dddddddd-0000-4000-8000-000000000001', 'test co of sales3', 'cccccccc-0000-4000-8000-000000000c');

create function pg_temp.as_user(uid uuid, stmt text) returns text
language plpgsql as $$
declare
  n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    execute stmt;
    get diagnostics n = row_count;
    reset role;
    return 'ok:' || n;
  exception when others then
    reset role;
    return 'error:' || sqlerrm;
  end;
end
$$;

create function pg_temp.expect(name text, actual text, wanted text) returns void
language plpgsql as $$
begin
  if actual not like wanted then
    raise exception 'FAIL %: got "%", wanted like "%"', name, actual, wanted;
  end if;
  raise notice 'pass  %', name;
end
$$;

\set root   '''cccccccc-0000-4000-8000-000000000a'''
\set admin  '''cccccccc-0000-4000-8000-000000000b'''
\set sales1 '''cccccccc-0000-4000-8000-000000000c'''
\set sales2 '''cccccccc-0000-4000-8000-000000000d'''

select pg_temp.expect('everyone sees the company',
  pg_temp.as_user(:sales2, $$select 1 from public.companies where id = 'dddddddd-0000-4000-8000-000000000001' having count(*) = 1$$), 'ok:1');

select pg_temp.expect('sales creates a company (becomes owner)',
  pg_temp.as_user(:sales1, $$insert into public.companies (name, owner_id) values ('new co', 'cccccccc-0000-4000-8000-000000000c')$$), 'ok:1');
select pg_temp.expect('sales cannot create a company owned by someone else',
  pg_temp.as_user(:sales1, $$insert into public.companies (name, owner_id) values ('bad co', 'cccccccc-0000-4000-8000-000000000d')$$), 'error:%row-level security%');

select pg_temp.expect('sales adds a contact to their own company',
  pg_temp.as_user(:sales1, $$insert into public.contacts (company_id, full_name, owner_id) values ('dddddddd-0000-4000-8000-000000000001', 'คุณเอ', 'cccccccc-0000-4000-8000-000000000c')$$), 'ok:1');

select pg_temp.expect('sales cannot edit a company they do not own',
  pg_temp.as_user(:sales2, $$update public.companies set name = 'hacked' where id = 'dddddddd-0000-4000-8000-000000000001'$$), 'ok:0');
select pg_temp.expect('admin edits any company',
  pg_temp.as_user(:admin, $$update public.companies set name = 'renamed by admin' where id = 'dddddddd-0000-4000-8000-000000000001'$$), 'ok:1');

select pg_temp.expect('sales cannot delete a company',
  pg_temp.as_user(:sales1, $$delete from public.companies where id = 'dddddddd-0000-4000-8000-000000000001'$$), 'ok:0');
select pg_temp.expect('admin cannot delete a company',
  pg_temp.as_user(:admin, $$delete from public.companies where id = 'dddddddd-0000-4000-8000-000000000001'$$), 'ok:0');
select pg_temp.expect('root deletes a company (cascades its contacts)',
  pg_temp.as_user(:root, $$delete from public.companies where id = 'dddddddd-0000-4000-8000-000000000001'$$), 'ok:1');
select pg_temp.expect('cascade removed the contact too',
  pg_temp.as_user(:root, $$select 1 from public.contacts where company_id = 'dddddddd-0000-4000-8000-000000000001' having count(*) = 0$$), 'ok:0');

do $$ begin raise notice 'ALL COMPANIES/CONTACTS TESTS PASSED'; end $$;

rollback;
```

- [ ] **Step 4: Run it**

Run: `docker exec -i supabase_db_Workspaces psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/companies_contacts.test.sql 2>&1 | grep -E "FAIL|ERROR|PASSED"`
Expected: every line starts `pass`, ends with `NOTICE:  ALL COMPANIES/CONTACTS TESTS PASSED`, no `FAIL`/`ERROR`.

- [ ] **Step 5: Commit**

```bash
cd /Users/iddh/Workspaces/supabase
git add migrations/20260924000000_companies_contacts.sql tests/companies_contacts.test.sql
git commit -m "feat: add companies and contacts tables

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 2: Migration — point `leads` at companies/contacts

**Files:**
- Create: `supabase/migrations/20260924010000_leads_company_contact_fk.sql`
- Modify: `supabase/tests/roles.test.sql` (its lead fixtures currently insert `company`/`contact`/`phone`/`email` directly — they must insert `company_id` instead, or every existing test breaks)

**Interfaces:**
- Consumes: `public.companies(id)` from Task 1.
- Produces: `public.leads` gains `company_id uuid not null references companies(id)` and `primary_contact_id uuid null references contacts(id) on delete set null`; loses `company, contact, phone, email, postcode, gender, occupation, address1, address2, sub_district, district, province, status`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260924010000_leads_company_contact_fk.sql
-- A deal now belongs to a company (many deals per company) and optionally points at one of
-- that company's contacts. The personal/address fields that used to live here moved to
-- `contacts` in the previous migration — they describe a person, not a deal.
-- No existing rows to backfill (confirmed no production data yet), so company_id can be
-- required immediately — this would fail with data present and need a two-step backfill first.
alter table public.leads
  add column company_id uuid not null references public.companies (id),
  add column primary_contact_id uuid references public.contacts (id) on delete set null;

alter table public.leads
  drop column company,
  drop column contact,
  drop column phone,
  drop column email,
  drop column postcode,
  drop column gender,
  drop column occupation,
  drop column address1,
  drop column address2,
  drop column sub_district,
  drop column district,
  drop column province,
  drop column status;

create index leads_company_id_idx on public.leads (company_id);
```

- [ ] **Step 2: Update the existing RLS test's lead fixtures**

`supabase/tests/roles.test.sql` inserts fixture leads directly against the old columns. Read the file first, then replace its lead-fixture block (the `insert into public.leads (id, company, owner_id) values ...` statement) so it creates a company per fixture lead first:

```sql
insert into public.companies (id, name, owner_id) values
  ('bbbbbbbb-1000-4000-8000-000000000001', 'company of sales1 lead', 'aaaaaaaa-0000-4000-8000-00000000000c'),
  ('bbbbbbbb-1000-4000-8000-000000000002', 'company of sales2 lead', 'aaaaaaaa-0000-4000-8000-00000000000d');

insert into public.leads (id, company_id, owner_id) values
  ('bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-1000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000c'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'bbbbbbbb-1000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-00000000000d');
```

Also fix the two `insert into public.leads (company, owner_id) values (...)` statements further down (the "sales creates own lead" / "sales cannot create lead for someone else" checks) to use `company_id` pointing at `'bbbbbbbb-1000-4000-8000-000000000001'` instead of a bare `company` string.

- [ ] **Step 3: Apply and run both test files**

Run: `cd supabase && supabase db reset`
Expected: all four migrations apply with no error.

Run: `docker exec -i supabase_db_Workspaces psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/roles.test.sql 2>&1 | grep -E "FAIL|ERROR|PASSED"`
Expected: `NOTICE:  ALL ROLE TESTS PASSED`, no `FAIL`.

Run: `docker exec -i supabase_db_Workspaces psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/companies_contacts.test.sql 2>&1 | grep -E "FAIL|ERROR|PASSED"`
Expected: `NOTICE:  ALL COMPANIES/CONTACTS TESTS PASSED`.

- [ ] **Step 4: Commit**

```bash
cd /Users/iddh/Workspaces/supabase
git add migrations/20260924010000_leads_company_contact_fk.sql tests/roles.test.sql
git commit -m "feat: point leads at companies/contacts, drop free-text fields

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 3: Zod schemas for companies/contacts, update lead schemas

**Files:**
- Modify: `src/lib/schemas.ts`

**Interfaces:**
- Consumes: nothing new (same `text`, `optionalText`, `optionalUrl`, `phone` helpers already in the file).
- Produces: `companyCreate`, `companyUpdate`, `contactInput`, `contactCreate`, `contactUpdate` — later API-route tasks import these exact names.

- [ ] **Step 1: Read the current file, then replace the `leadInput`/`leadCreate` block**

Read `src/lib/schemas.ts` first (it changed since this plan was written — Phase 2 hasn't touched it yet, but confirm before editing). Replace the existing `leadInput`/`leadCreate`/`leadUpdate` block with:

```ts
export const leadInput = z.object({
  company_id: z.uuid(),
  primary_contact_id: z.union([z.null(), z.uuid()]).optional(),
  cert: z.array(text(100)).max(10).default([]),
  stage: z.enum(['new', 'contacted', 'quoted', 'negotiating', 'won', 'lost']),
  value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  notes: text(5000),
  quote_link: optionalUrl(500),
  owner_id: z.uuid(),
});
export const leadCreate = leadInput.partial({
  primary_contact_id: true,
  cert: true,
  stage: true,
  value: true,
  notes: true,
  quote_link: true,
  owner_id: true,
});
export const leadUpdate = leadInput.partial();
```

- [ ] **Step 2: Add company/contact schemas**

Add this block right after `leadUpdate` (before `activityCreate`):

```ts
export const companyCreate = z.object({
  name: text(200).min(1),
  owner_id: z.uuid().optional(),
});
export const companyUpdate = companyCreate.partial();

export const contactInput = z.object({
  company_id: z.uuid(),
  full_name: text(200).min(1),
  position: text(100),
  phone,
  email: z.union([z.literal(''), z.email().max(200)]),
  gender: optionalText(50),
  occupation: optionalText(200),
  postcode: optionalText(50),
  address1: optionalText(200),
  address2: optionalText(200),
  sub_district: optionalText(100),
  district: optionalText(100),
  province: optionalText(100),
  status: z.number().int().min(0).max(32767).default(1),
  owner_id: z.uuid(),
});
export const contactCreate = contactInput.partial({
  position: true,
  phone: true,
  email: true,
  gender: true,
  occupation: true,
  postcode: true,
  address1: true,
  address2: true,
  sub_district: true,
  district: true,
  province: true,
  status: true,
  owner_id: true,
});
export const contactUpdate = contactInput.partial();
```

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: `- 0 errors` (existing API routes that reference the old `leadInput` shape will now show errors — that's expected and fixed in Tasks 5-6; if this task is done standalone, ignore errors in `src/pages/api/leads*.ts` specifically and confirm `schemas.ts` itself has no syntax errors by checking the output mentions no error at `schemas.ts`).

- [ ] **Step 4: Commit**

```bash
git add src/lib/schemas.ts
git commit -m "feat: add company/contact schemas, update lead schema for company_id

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 4: `/api/companies` routes

**Files:**
- Create: `src/pages/api/companies.ts`
- Create: `src/pages/api/companies/[id].ts`

**Interfaces:**
- Consumes: `companyCreate`, `companyUpdate` from Task 3; `json`, `fail`, `parseBody`, `dbError` from `src/lib/api.ts`; `requireRoot` from `src/lib/auth.ts`; `uuidParam` from `src/lib/schemas.ts`.
- Produces: `GET/POST /api/companies`, `PUT/DELETE /api/companies/:id` — the UI tasks call these.

- [ ] **Step 1: Write `src/pages/api/companies.ts`**

```ts
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
```

- [ ] **Step 2: Write `src/pages/api/companies/[id].ts`**

```ts
import type { APIRoute } from 'astro';
import { json, fail, parseBody, dbError } from '@/lib/api';
import { requireRoot } from '@/lib/auth';
import { companyUpdate, uuidParam } from '@/lib/schemas';

export const prerender = false;

export const PUT: APIRoute = async ({ locals, request, params }) => {
  const id = uuidParam.safeParse(params.id);
  if (!id.success) return fail('Invalid id', 400);

  const body = await parseBody(request, companyUpdate);
  if (body instanceof Response) return body;
  if (Object.keys(body).length === 0) return fail('Nothing to update', 400);

  const { data, error } = await locals.supabase.from('companies').update(body).eq('id', id.data).select('id');
  if (error) return dbError(error);
  if (data.length === 0) return fail('Not found', 404);
  return json({ ok: true });
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  // RLS only lets root delete, but answer 403 (not a misleading 404) for everyone else.
  // A company that still has deals fails on the leads.company_id foreign key (no cascade) —
  // dbError() reports it as a generic 500; that's intentional, deleting deal history silently
  // would be worse.
  const denied = await requireRoot(locals);
  if (denied) return denied;

  const id = uuidParam.safeParse(params.id);
  if (!id.success) return fail('Invalid id', 400);

  const { data, error } = await locals.supabase.from('companies').delete().eq('id', id.data).select('id');
  if (error) return dbError(error);
  if (data.length === 0) return fail('Not found', 404);
  return json({ ok: true });
};
```

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: no errors reported for `src/pages/api/companies.ts` or `src/pages/api/companies/[id].ts`.

- [ ] **Step 4: Commit**

```bash
git add src/pages/api/companies.ts "src/pages/api/companies/[id].ts"
git commit -m "feat: add /api/companies routes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 5: `/api/contacts` routes

**Files:**
- Create: `src/pages/api/contacts.ts`
- Create: `src/pages/api/contacts/[id].ts`

**Interfaces:**
- Consumes: `contactCreate`, `contactUpdate` from Task 3.
- Produces: `GET /api/contacts?company_id=<uuid>` (list a company's contacts; no param lists all), `POST /api/contacts`, `PUT/DELETE /api/contacts/:id`.

- [ ] **Step 1: Write `src/pages/api/contacts.ts`**

```ts
import type { APIRoute } from 'astro';
import { json, fail, parseBody, dbError } from '@/lib/api';
import { contactCreate, uuidParam } from '@/lib/schemas';

export const prerender = false;

export const GET: APIRoute = async ({ locals, url }) => {
  let query = locals.supabase.from('contacts').select('*').order('full_name');
  const companyId = url.searchParams.get('company_id');
  if (companyId) {
    const parsed = uuidParam.safeParse(companyId);
    if (!parsed.success) return fail('Invalid company_id', 400);
    query = query.eq('company_id', parsed.data);
  }
  const { data, error } = await query;
  if (error) return dbError(error);
  return json(data);
};

export const POST: APIRoute = async ({ locals, request }) => {
  const body = await parseBody(request, contactCreate);
  if (body instanceof Response) return body;

  const { data, error } = await locals.supabase.from('contacts').insert(body).select('*').single();
  if (error) return dbError(error);
  return json(data, 201);
};
```

- [ ] **Step 2: Write `src/pages/api/contacts/[id].ts`**

```ts
import type { APIRoute } from 'astro';
import { json, fail, parseBody, dbError } from '@/lib/api';
import { requireRoot } from '@/lib/auth';
import { contactUpdate, uuidParam } from '@/lib/schemas';

export const prerender = false;

export const PUT: APIRoute = async ({ locals, request, params }) => {
  const id = uuidParam.safeParse(params.id);
  if (!id.success) return fail('Invalid id', 400);

  const body = await parseBody(request, contactUpdate);
  if (body instanceof Response) return body;
  if (Object.keys(body).length === 0) return fail('Nothing to update', 400);

  const { data, error } = await locals.supabase.from('contacts').update(body).eq('id', id.data).select('id');
  if (error) return dbError(error);
  if (data.length === 0) return fail('Not found', 404);
  return json({ ok: true });
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  // RLS only lets root delete, but answer 403 (not a misleading 404) for everyone else.
  // Any lead whose primary_contact_id pointed here just has it set to null (ON DELETE SET NULL) —
  // deleting a contact never blocks or destroys a deal.
  const denied = await requireRoot(locals);
  if (denied) return denied;

  const id = uuidParam.safeParse(params.id);
  if (!id.success) return fail('Invalid id', 400);

  const { data, error } = await locals.supabase.from('contacts').delete().eq('id', id.data).select('id');
  if (error) return dbError(error);
  if (data.length === 0) return fail('Not found', 404);
  return json({ ok: true });
};
```

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: no errors for either new file.

- [ ] **Step 4: Commit**

```bash
git add src/pages/api/contacts.ts "src/pages/api/contacts/[id].ts"
git commit -m "feat: add /api/contacts routes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 6: Update `/api/leads` routes for company_id/primary_contact_id

**Files:**
- Modify: `src/pages/api/leads.ts`
- Modify: `src/pages/api/leads/[id].ts`

**Interfaces:**
- Consumes: `leadCreate`, `leadUpdate` from Task 3 (already updated).
- Produces: `GET /api/leads` rows now include `company: {name}` and `primary_contact: {full_name, position}` (embedded via PostgREST join) instead of flat `company`/`contact` strings — later UI tasks read `lead.company.name` and `lead.primary_contact?.full_name`.

- [ ] **Step 1: Update `src/pages/api/leads.ts`**

Read the file first. Replace the `COLUMNS` constant and the `POST` handler:

```ts
const COLUMNS =
  '*, company:companies!company_id(name), primary_contact:contacts!primary_contact_id(full_name, position), owner:profiles!owner_id(full_name)';
```

```ts
export const POST: APIRoute = async ({ locals, request }) => {
  const body = await parseBody(request, leadCreate);
  if (body instanceof Response) return body;

  if (body.primary_contact_id) {
    const { data: contact, error: contactError } = await locals.supabase
      .from('contacts')
      .select('id')
      .eq('id', body.primary_contact_id)
      .eq('company_id', body.company_id)
      .maybeSingle();
    if (contactError) return dbError(contactError);
    if (!contact) return fail('primary_contact_id does not belong to company_id', 400);
  }

  const { data, error } = await locals.supabase.from('leads').insert(body).select(COLUMNS).single();
  if (error) return dbError(error);
  return json(data, 201);
};
```

This POST handler now uses `fail`, which the file doesn't currently import — update the import line to
`import { json, fail, parseBody, dbError } from '@/lib/api';`.

- [ ] **Step 2: Update `src/pages/api/leads/[id].ts`'s `PUT`**

Read the file first. Replace the `PUT` handler (leave `DELETE` untouched):

```ts
export const PUT: APIRoute = async ({ locals, request, params }) => {
  const id = uuidParam.safeParse(params.id);
  if (!id.success) return fail('Invalid id', 400);

  const body = await parseBody(request, leadUpdate);
  if (body instanceof Response) return body;
  if (Object.keys(body).length === 0) return fail('Nothing to update', 400);

  if (body.primary_contact_id) {
    let companyId = body.company_id;
    if (!companyId) {
      const { data: existing, error: fetchError } = await locals.supabase
        .from('leads')
        .select('company_id')
        .eq('id', id.data)
        .maybeSingle();
      if (fetchError) return dbError(fetchError);
      if (!existing) return fail('Not found', 404);
      companyId = existing.company_id;
    }
    const { data: contact, error: contactError } = await locals.supabase
      .from('contacts')
      .select('id')
      .eq('id', body.primary_contact_id)
      .eq('company_id', companyId)
      .maybeSingle();
    if (contactError) return dbError(contactError);
    if (!contact) return fail('primary_contact_id does not belong to company_id', 400);
  }

  // RLS filters rows the user doesn't own, so "no row" means not found or not allowed.
  const { data, error } = await locals.supabase
    .from('leads')
    .update(body)
    .eq('id', id.data)
    .select('id');
  if (error) return dbError(error);
  if (data.length === 0) return fail('Not found', 404);
  return json({ ok: true });
};
```

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: `- 0 errors`.

- [ ] **Step 4: Commit**

```bash
git add src/pages/api/leads.ts "src/pages/api/leads/[id].ts"
git commit -m "feat: leads API validates and joins company/contact

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 7: Rewrite seed data for companies/contacts/leads

**Files:**
- Modify: `supabase/seed.sql`

**Interfaces:**
- Consumes: nothing new.
- Produces: 8 seed companies (ids `44444444-0000-4000-8000-00000000000N`), one contact per company (ids `55555555-0000-4000-8000-00000000000N`), 8 leads referencing them (same lead ids as before, so Task 8/9's manual verification steps can reuse them).

- [ ] **Step 1: Replace the leads insert block**

Read `supabase/seed.sql` first. Replace the whole `-- ── Leads: every pipeline stage is represented ──` block (the `insert into public.leads (...)` statement and its `values (...)` table) with:

```sql
-- ── Companies + contacts: one company and one contact per seed lead ─────────
insert into public.companies (id, name, owner_id)
select v.id, v.name, o.id
from (values
  ('44444444-0000-4000-8000-000000000001'::uuid, 'บริษัท สยามฟู้ดส์ จำกัด'),
  ('44444444-0000-4000-8000-000000000002'::uuid, 'บริษัท ไทยออโต้พาร์ท จำกัด'),
  ('44444444-0000-4000-8000-000000000003'::uuid, 'บริษัท กรีนเทค เอ็นเนอร์ยี่ จำกัด'),
  ('44444444-0000-4000-8000-000000000004'::uuid, 'โรงพยาบาลเอกชัย'),
  ('44444444-0000-4000-8000-000000000005'::uuid, 'บริษัท พรีเมียร์ก่อสร้าง จำกัด'),
  ('44444444-0000-4000-8000-000000000006'::uuid, 'บริษัท เอ็มเค อินโนเวชั่น จำกัด'),
  ('44444444-0000-4000-8000-000000000007'::uuid, 'บริษัท โกลเด้นฟาร์ม จำกัด'),
  ('44444444-0000-4000-8000-000000000008'::uuid, 'บริษัท บางกอกโลจิสติกส์ จำกัด')
) as v(id, name)
cross join (select id from public.profiles order by created_at limit 1) as o
on conflict (id) do nothing;

insert into public.contacts (id, company_id, full_name, position, phone, email, owner_id)
select v.id, v.company_id, v.full_name, v.position, v.phone, v.email, o.id
from (values
  ('55555555-0000-4000-8000-000000000001'::uuid, '44444444-0000-4000-8000-000000000001'::uuid, 'คุณสมชาย ใจดี',   'จัดซื้อ',    '0812345678', 'somchai@siamfoods.example'),
  ('55555555-0000-4000-8000-000000000002'::uuid, '44444444-0000-4000-8000-000000000002'::uuid, 'คุณวิภา รักษ์ดี', 'QMR',       '0897654321', 'wipa@thaiautopart.example'),
  ('55555555-0000-4000-8000-000000000003'::uuid, '44444444-0000-4000-8000-000000000003'::uuid, 'คุณประเสริฐ มั่นคง', 'เจ้าของ', '0861112233', 'prasert@greentech.example'),
  ('55555555-0000-4000-8000-000000000004'::uuid, '44444444-0000-4000-8000-000000000004'::uuid, 'คุณนภา ศรีสุข',   'QA Manager', '0234567890', 'napa@ekachai-hosp.example'),
  ('55555555-0000-4000-8000-000000000005'::uuid, '44444444-0000-4000-8000-000000000005'::uuid, 'คุณอนุชา เพชรดี', 'เจ้าของ',   '0819998877', 'anucha@premier-c.example'),
  ('55555555-0000-4000-8000-000000000006'::uuid, '44444444-0000-4000-8000-000000000006'::uuid, 'คุณกมล วงศ์ทอง',  'จัดซื้อ',    '0825550101', 'kamol@mkinno.example'),
  ('55555555-0000-4000-8000-000000000007'::uuid, '44444444-0000-4000-8000-000000000007'::uuid, 'คุณสุดา แก้วมณี', 'เจ้าของ',   '0852223344', 'suda@goldenfarm.example'),
  ('55555555-0000-4000-8000-000000000008'::uuid, '44444444-0000-4000-8000-000000000008'::uuid, 'คุณธนกร ยิ่งเจริญ', 'QMR',     '0834445566', 'thanakorn@bkklogis.example')
) as v(id, company_id, full_name, position, phone, email)
cross join (select id from public.profiles order by created_at limit 1) as o
on conflict (id) do nothing;

-- ── Leads: every pipeline stage is represented ──────────────────────────────
insert into public.leads (id, company_id, primary_contact_id, cert, stage, value, notes, owner_id)
select v.id, v.company_id, v.contact_id, array[v.cert], v.stage, v.value, v.notes, o.id
from (values
  ('11111111-0000-4000-8000-000000000001'::uuid, '44444444-0000-4000-8000-000000000001'::uuid, '55555555-0000-4000-8000-000000000001'::uuid, 'ISO 22000', 'new',         250000::bigint, 'สนใจขอรับรองโรงงานแห่งใหม่'),
  ('11111111-0000-4000-8000-000000000002'::uuid, '44444444-0000-4000-8000-000000000002'::uuid, '55555555-0000-4000-8000-000000000002'::uuid, 'ISO 9001',  'contacted',   180000::bigint, 'นัดคุยรายละเอียดสัปดาห์หน้า'),
  ('11111111-0000-4000-8000-000000000003'::uuid, '44444444-0000-4000-8000-000000000003'::uuid, '55555555-0000-4000-8000-000000000003'::uuid, 'ISO 14001', 'quoted',      320000::bigint, 'ส่งใบเสนอราคาแล้ว รอตอบกลับ'),
  ('11111111-0000-4000-8000-000000000004'::uuid, '44444444-0000-4000-8000-000000000004'::uuid, '55555555-0000-4000-8000-000000000004'::uuid, 'ISO 27001', 'negotiating', 450000::bigint, 'ต่อรองขอบเขตงานและราคา'),
  ('11111111-0000-4000-8000-000000000005'::uuid, '44444444-0000-4000-8000-000000000005'::uuid, '55555555-0000-4000-8000-000000000005'::uuid, 'ISO 45001', 'won',         280000::bigint, 'ปิดดีลแล้ว เริ่มงานเดือนหน้า'),
  ('11111111-0000-4000-8000-000000000006'::uuid, '44444444-0000-4000-8000-000000000006'::uuid, '55555555-0000-4000-8000-000000000006'::uuid, 'ISO 9001',  'lost',        120000::bigint, 'เลือกผู้ให้บริการรายอื่นเพราะราคา'),
  ('11111111-0000-4000-8000-000000000007'::uuid, '44444444-0000-4000-8000-000000000007'::uuid, '55555555-0000-4000-8000-000000000007'::uuid, 'GHPs HACCP','new',          95000::bigint, ''),
  ('11111111-0000-4000-8000-000000000008'::uuid, '44444444-0000-4000-8000-000000000008'::uuid, '55555555-0000-4000-8000-000000000008'::uuid, 'ISO 9001',  'contacted',   210000::bigint, 'ขอตัวอย่างขั้นตอนการตรวจประเมิน')
) as v(id, company_id, contact_id, cert, stage, value, notes)
cross join (select id from public.profiles order by created_at limit 1) as o
on conflict (id) do nothing;
```

Note the cert value for the 7th row changed from `'GMP/HACCP'` to `'GHPs HACCP'` — the old value isn't in `CERT_OPTIONS` any more (that list was replaced with the real RIC service list earlier); this keeps seed data consistent with what the UI actually offers.

- [ ] **Step 2: Reset and eyeball the result**

Run: `cd supabase && supabase db reset`
Expected: no error; ends with `Finished supabase db reset on branch main.`

Run: `docker exec supabase_db_Workspaces psql -U postgres -c "select l.id, c.name as company, ct.full_name as contact, l.stage from public.leads l join public.companies c on c.id = l.company_id left join public.contacts ct on ct.id = l.primary_contact_id order by l.created_at;"`
Expected: 8 rows, each with a non-null `company`, and 7 of 8 with a non-null `contact` (all 8 should have one — verify all 8 show a contact name, not blank).

- [ ] **Step 3: Commit**

```bash
cd /Users/iddh/Workspaces/supabase
git add seed.sql
git commit -m "feat: seed companies/contacts, point seed leads at them

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 8: "บริษัท" page — company list, detail, contact CRUD

This task also relocates the postcode→ตำบล/อำเภอ/จังหวัด cascade (currently hardcoded to `lead-*` element ids) onto the contact form, since gender/occupation/address fields no longer live on a lead. Task 9 removes them from the lead form.

**Files:**
- Modify: `src/pages/index.astro`

**Interfaces:**
- Consumes: `/api/companies`, `/api/contacts` from Tasks 4-5.
- Produces: global arrays `companies`, `contacts`; functions `openCompanyDetail(id)`, `openDeal(id)` (also used by Task 9's Pipeline card and Phase 2's activity feed), `populateSubDistricts(prefix, zip, name)` / `setDistrictProvince(prefix, ...)` / `onPostcodeInput(prefix)` / `onSubDistrictChange(prefix)` now all take a `prefix` argument.

- [ ] **Step 1: Add the nav item**

Find (in the `<nav>` block, right before the `nav-activities` button):

```html
    <button onclick="showView('activities')" class="nav-item w-full text-left" id="nav-activities">
```

Insert a new button immediately before it:

```html
    <button onclick="showView('companies')" class="nav-item w-full text-left" id="nav-companies">
      <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2M5 21H3m4-14h6M7 11h6M7 15h6"/></svg>
      บริษัท
    </button>
    <button onclick="showView('activities')" class="nav-item w-full text-left" id="nav-activities">
```

- [ ] **Step 2: Add the two new view sections**

Find the `<!-- ACTIVITIES -->` comment and insert two new `<div>` view sections immediately before it:

```html
  <!-- COMPANIES -->
  <div id="view-companies" class="hidden p-6">
    <h1 class="text-xl font-semibold mb-6">บริษัท</h1>
    <form id="company-form" class="bg-white rounded-xl p-5 shadow-xs border border-gray-100 flex items-end gap-3 mb-6" onsubmit="createCompany(event)">
      <div class="flex-1">
        <label class="field-label">ชื่อบริษัทใหม่</label>
        <input class="field-input" id="company-name" required placeholder="บริษัท ... จำกัด" />
      </div>
      <button type="submit" class="btn-primary">เพิ่มบริษัท</button>
    </form>
    <div id="companies-list" class="space-y-3"></div>
  </div>

  <!-- COMPANY DETAIL -->
  <div id="view-company-detail" class="hidden p-6">
    <button onclick="closeCompanyDetail()" class="text-sm text-ric-gray hover:text-ric-black mb-4">← กลับ</button>
    <h1 class="text-xl font-semibold mb-6" id="company-detail-name">—</h1>
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div>
        <div class="flex items-center justify-between mb-3">
          <h2 class="font-semibold text-sm">ผู้ติดต่อ</h2>
          <button onclick="openContactModal()" class="btn-primary text-xs px-3 py-1.5">+ เพิ่มผู้ติดต่อ</button>
        </div>
        <div id="company-contacts-list" class="space-y-2"></div>
      </div>
      <div>
        <h2 class="font-semibold text-sm mb-3">ดีลของบริษัทนี้</h2>
        <div id="company-deals-list" class="bg-white rounded-xl shadow-xs border border-gray-100 divide-y divide-gray-50"></div>
      </div>
    </div>
  </div>

  <!-- ACTIVITIES -->
```

- [ ] **Step 3: Add the contact modal**

Find `<!-- MODAL: Renewal -->` and insert a new modal immediately before it:

```html
<!-- MODAL: Contact -->
<div id="modal-contact" class="modal-overlay hidden" onclick="if(event.target===this)closeContactModal()">
  <div class="modal-box">
    <div class="flex items-center justify-between p-5 border-b border-gray-100">
      <h3 class="font-semibold" id="contact-modal-title">เพิ่มผู้ติดต่อ</h3>
      <button onclick="closeContactModal()" class="text-ric-gray hover:text-ric-black">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    </div>
    <form id="contact-form" class="p-5 space-y-4" onsubmit="saveContact(event)">
      <input type="hidden" id="contact-id" />
      <div class="grid grid-cols-2 gap-4">
        <div class="col-span-2">
          <label class="field-label">ชื่อ-นามสกุล *</label>
          <input class="field-input" id="contact-full-name" required placeholder="ชื่อ-นามสกุล" />
        </div>
        <div>
          <label class="field-label">ตำแหน่ง</label>
          <input class="field-input" id="contact-position" placeholder="เช่น QMR, จัดซื้อ, เจ้าของ" />
        </div>
        <div>
          <label class="field-label">เบอร์โทร</label>
          <input class="field-input" id="contact-phone" type="tel" inputmode="numeric" pattern="[0-9]*" maxlength="10" oninput="this.value = this.value.replace(/\D/g, '').slice(0, 10)" placeholder="0812345678" />
        </div>
        <div class="col-span-2">
          <label class="field-label">อีเมล</label>
          <input class="field-input" id="contact-email" type="email" placeholder="name@company.com" />
        </div>
        <div class="col-span-2 pt-2 border-t border-gray-100">
          <p class="text-xs font-semibold text-ric-gray uppercase tracking-wider">ข้อมูลส่วนตัว/ที่อยู่ (ไม่บังคับ)</p>
        </div>
        <div>
          <label class="field-label">เพศ</label>
          <select class="field-input" id="contact-gender">
            <option value="">ไม่ระบุ</option>
            <option value="male">ชาย</option>
            <option value="female">หญิง</option>
            <option value="other">อื่นๆ</option>
          </select>
        </div>
        <div>
          <label class="field-label">อาชีพ</label>
          <input class="field-input" id="contact-occupation" placeholder="อาชีพ" />
        </div>
        <div>
          <label class="field-label">รหัสไปรษณีย์</label>
          <input class="field-input" id="contact-postcode" placeholder="10xxx" inputmode="numeric" pattern="[0-9]*" maxlength="5" oninput="onPostcodeInput('contact')" />
        </div>
        <div>
          <label class="field-label">ตำบล/แขวง</label>
          <select class="field-input disabled:bg-gray-50 disabled:text-ric-gray" id="contact-sub-district" onchange="onSubDistrictChange('contact')" disabled>
            <option value="">-- กรอกรหัสไปรษณีย์ก่อน --</option>
          </select>
        </div>
        <div>
          <label class="field-label">อำเภอ/เขต</label>
          <input class="field-input bg-gray-50" id="contact-district" readonly placeholder="อัตโนมัติจากตำบล" />
        </div>
        <div>
          <label class="field-label">จังหวัด</label>
          <input class="field-input bg-gray-50" id="contact-province" readonly placeholder="อัตโนมัติจากตำบล" />
        </div>
        <div class="col-span-2">
          <label class="field-label">ที่อยู่ 1</label>
          <input class="field-input" id="contact-address1" placeholder="บ้านเลขที่ ถนน" />
        </div>
        <div class="col-span-2">
          <label class="field-label">ที่อยู่ 2</label>
          <input class="field-input" id="contact-address2" placeholder="หมู่บ้าน/อาคาร (ถ้ามี)" />
        </div>
      </div>
      <div class="flex justify-between pt-2">
        <button type="button" id="contact-delete-btn" onclick="deleteContact()" class="btn-danger hidden">ลบผู้ติดต่อนี้</button>
        <div class="flex gap-2 ml-auto">
          <button type="button" onclick="closeContactModal()" class="btn-secondary">ยกเลิก</button>
          <button type="submit" class="btn-primary">บันทึก</button>
        </div>
      </div>
    </form>
  </div>
</div>

<!-- MODAL: Renewal -->
```

- [ ] **Step 4: Load companies/contacts, add state**

Find (in the state block near the top of the `<script is:inline>`):

```js
let leads = [];
let activities = [];
let renewals = [];
```

Replace with:

```js
let leads = [];
let activities = [];
let renewals = [];
let companies = [];
let contacts = [];
let currentCompanyId = null;
```

Find `async function loadAll() {` and replace its whole body to also fetch companies/contacts:

```js
async function loadAll() {
  const [l, a, r, co, ct, who] = await Promise.all([
    api('/api/leads'),
    api('/api/activities'),
    api('/api/renewals'),
    api('/api/companies'),
    api('/api/contacts'),
    api('/api/me'),
  ]);
  me = who.me;
  profiles = who.profiles;
  setupOwnerPickers();
  leads = l;
  activities = a;
  renewals = r;
  companies = co;
  contacts = ct;
  renderAll();
}
```

- [ ] **Step 5: Wire the new views into `showView`/`renderAll`**

Find:

```js
function renderAll() {
  if (currentView === 'dashboard') renderDashboard();
  if (currentView === 'pipeline') renderPipeline();
  if (currentView === 'renewals') renderRenewals();
  if (currentView === 'activities') renderActivities();
}
```

Replace with:

```js
function renderAll() {
  if (currentView === 'dashboard') renderDashboard();
  if (currentView === 'pipeline') renderPipeline();
  if (currentView === 'renewals') renderRenewals();
  if (currentView === 'activities') renderActivities();
  if (currentView === 'companies') renderCompanies();
}

// Shared by the "กิจกรรม" feed (Phase 2) and the company-detail deals list: jump straight to
// a deal's edit modal from anywhere in the app.
function openDeal(id) {
  showView('pipeline');
  openLeadModal(id);
}
```

- [ ] **Step 6: Add company list/detail rendering and CRUD**

Add this block right before the `// ── Lead Modal ──` comment (i.e. after `getCertCheckboxes()`/postcode helpers, before `openLeadModal`):

```js
// ── Companies ─────────────────────────────────────────────────────────────
function renderCompanies() {
  const sorted = [...companies].sort((a, b) => a.name.localeCompare(b.name, 'th'));
  document.getElementById('companies-list').innerHTML = sorted.length
    ? sorted.map(co => {
        const contactCount = contacts.filter(c => c.company_id === co.id).length;
        const dealCount = leads.filter(l => l.company_id === co.id).length;
        return `<div class="bg-white rounded-xl p-4 shadow-xs border border-gray-100 flex items-center justify-between cursor-pointer hover:bg-gray-50" onclick="openCompanyDetail('${esc(co.id)}')">
          <p class="font-medium text-sm">${esc(co.name)}</p>
          <p class="text-xs text-ric-gray">${contactCount} ผู้ติดต่อ · ${dealCount} ดีล</p>
        </div>`;
      }).join('')
    : '<div class="bg-white rounded-xl p-8 text-center text-sm text-ric-gray shadow-xs border border-gray-100">ยังไม่มีบริษัท</div>';
}

async function createCompany(e) {
  e.preventDefault();
  try {
    companies.push(await api('/api/companies', {
      method: 'POST',
      body: JSON.stringify({ name: document.getElementById('company-name').value }),
    }));
  } catch (err) {
    alert('เพิ่มบริษัทไม่สำเร็จ: ' + err.message);
    return;
  }
  document.getElementById('company-form').reset();
  renderCompanies();
}

function openCompanyDetail(id) {
  currentCompanyId = id;
  document.querySelectorAll('[id^="view-"]').forEach(el => el.classList.add('hidden'));
  document.getElementById('view-company-detail').classList.remove('hidden');
  renderCompanyDetail();
}

function closeCompanyDetail() {
  currentCompanyId = null;
  showView('companies');
}

function renderCompanyDetail() {
  const company = companies.find(c => c.id === currentCompanyId);
  if (!company) { closeCompanyDetail(); return; }
  document.getElementById('company-detail-name').textContent = company.name;

  const companyContacts = contacts.filter(c => c.company_id === currentCompanyId);
  document.getElementById('company-contacts-list').innerHTML = companyContacts.length
    ? companyContacts.map(c => `<div class="bg-white rounded-xl p-4 shadow-xs border border-gray-100 flex items-center gap-4">
        <div class="flex-1 min-w-0">
          <p class="font-medium text-sm">${esc(c.full_name)}${c.position ? ` <span class="text-xs text-ric-gray">(${esc(c.position)})</span>` : ''}</p>
          <p class="text-xs text-ric-gray mt-0.5 font-mono">${esc(c.phone) || '—'} · ${esc(c.email) || '—'}</p>
        </div>
        <button onclick="openContactModal('${esc(c.id)}')" class="text-ric-gray hover:text-ric-black" title="แก้ไข">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
        </button>
      </div>`).join('')
    : '<div class="bg-white rounded-xl p-6 text-center text-sm text-ric-gray shadow-xs border border-gray-100">ยังไม่มีผู้ติดต่อ</div>';

  const companyDeals = leads.filter(l => l.company_id === currentCompanyId);
  document.getElementById('company-deals-list').innerHTML = companyDeals.length
    ? companyDeals.map(l => {
        const stage = STAGES.find(s => s.id === l.stage) || STAGES[0];
        return `<div class="flex items-center justify-between px-4 py-3 hover:bg-gray-50 cursor-pointer" onclick="openDeal('${esc(l.id)}')">
          <span class="text-sm">${esc(l.primary_contact?.full_name) || 'ไม่ระบุผู้ติดต่อ'}</span>
          <span class="text-xs px-2 py-0.5 rounded-full ${stage.color}">${stage.label}</span>
        </div>`;
      }).join('')
    : '<p class="text-sm text-ric-gray px-4 py-3">ยังไม่มีดีลของบริษัทนี้</p>';
}

// ── Contact Modal ─────────────────────────────────────────────────────────
async function openContactModal(id = null) {
  await loadPostcodeData();
  document.getElementById('contact-id').value = id || '';
  const deleteBtn = document.getElementById('contact-delete-btn');
  if (id) {
    const c = contacts.find(x => x.id === id);
    if (!c) return;
    document.getElementById('contact-modal-title').textContent = 'แก้ไขผู้ติดต่อ';
    document.getElementById('contact-full-name').value = c.full_name || '';
    document.getElementById('contact-position').value = c.position || '';
    document.getElementById('contact-phone').value = c.phone || '';
    document.getElementById('contact-email').value = c.email || '';
    document.getElementById('contact-gender').value = c.gender || '';
    document.getElementById('contact-occupation').value = c.occupation || '';
    document.getElementById('contact-address1').value = c.address1 || '';
    document.getElementById('contact-address2').value = c.address2 || '';
    document.getElementById('contact-postcode').value = c.postcode || '';
    populateSubDistricts('contact', c.postcode || '', c.sub_district || '');
    setDistrictProvince('contact', c.district || '', c.province || '');
    deleteBtn.classList.toggle('hidden', !isRoot());
  } else {
    document.getElementById('contact-modal-title').textContent = 'เพิ่มผู้ติดต่อ';
    document.getElementById('contact-form').reset();
    populateSubDistricts('contact', '', '');
    deleteBtn.classList.add('hidden');
  }
  document.getElementById('modal-contact').classList.remove('hidden');
}

function closeContactModal() {
  document.getElementById('modal-contact').classList.add('hidden');
}

async function saveContact(e) {
  e.preventDefault();
  const id = document.getElementById('contact-id').value;
  const data = {
    company_id: currentCompanyId,
    full_name: document.getElementById('contact-full-name').value,
    position: document.getElementById('contact-position').value,
    phone: document.getElementById('contact-phone').value,
    email: document.getElementById('contact-email').value,
    gender: nullableInput('contact-gender'),
    occupation: nullableInput('contact-occupation'),
    address1: nullableInput('contact-address1'),
    address2: nullableInput('contact-address2'),
    sub_district: nullableInput('contact-sub-district'),
    district: nullableInput('contact-district'),
    province: nullableInput('contact-province'),
    postcode: nullableInput('contact-postcode'),
  };
  try {
    if (id) {
      await api(`/api/contacts/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    } else {
      await api('/api/contacts', { method: 'POST', body: JSON.stringify(data) });
    }
    contacts = await api('/api/contacts');
  } catch (err) {
    alert('บันทึกไม่สำเร็จ: ' + err.message);
    return;
  }
  closeContactModal();
  renderCompanyDetail();
}

async function deleteContact() {
  const id = document.getElementById('contact-id').value;
  if (!id || !confirm('ลบผู้ติดต่อนี้ใช่ไหม?')) return;
  try {
    await api(`/api/contacts/${id}`, { method: 'DELETE' });
  } catch (err) {
    alert('ลบไม่สำเร็จ: ' + err.message);
    return;
  }
  contacts = contacts.filter(c => c.id !== id);
  closeContactModal();
  renderCompanyDetail();
}
```

- [ ] **Step 7: Re-parameterise the postcode cascade with a `prefix`**

Find the four functions `setDistrictProvince`, `populateSubDistricts`, `onPostcodeInput`, `onSubDistrictChange` (currently hardcoded to `lead-*` ids) and replace all four with:

```js
function setDistrictProvince(prefix, district, province) {
  document.getElementById(`${prefix}-district`).value = district;
  document.getElementById(`${prefix}-province`).value = province;
}

// Fills the sub-district dropdown for a zip code without touching district/province — used
// both when the user picks a postcode and when an edit form restores a saved one.
function populateSubDistricts(prefix, zip, selectedName) {
  const subSel = document.getElementById(`${prefix}-sub-district`);
  const entry = postcodeData?.find(e => e.zipCode === zip);
  if (!entry) {
    subSel.innerHTML = '<option value="">-- กรอกรหัสไปรษณีย์ก่อน --</option>';
    subSel.disabled = true;
    return;
  }
  subSel.disabled = false;
  subSel.innerHTML = '<option value="">-- เลือกตำบล/แขวง --</option>' +
    entry.subDistrictList.map(s => `<option value="${esc(s.subDistrictName)}">${esc(s.subDistrictName)}</option>`).join('');
  subSel.value = entry.subDistrictList.some(s => s.subDistrictName === selectedName) ? selectedName : '';
}

function onPostcodeInput(prefix) {
  const input = document.getElementById(`${prefix}-postcode`);
  const digits = input.value.replace(/\D/g, '').slice(0, 5);
  if (digits !== input.value) input.value = digits;

  populateSubDistricts(prefix, digits.length === 5 ? digits : '', '');
  setDistrictProvince(prefix, '', '');
  if (digits.length !== 5) return;

  // Only ~4% of zip codes have just one sub-district — auto-pick it when that's the case.
  const entry = postcodeData?.find(e => e.zipCode === digits);
  if (entry?.subDistrictList.length === 1) {
    document.getElementById(`${prefix}-sub-district`).value = entry.subDistrictList[0].subDistrictName;
    onSubDistrictChange(prefix);
  }
}

function onSubDistrictChange(prefix) {
  const zip = document.getElementById(`${prefix}-postcode`).value;
  const name = document.getElementById(`${prefix}-sub-district`).value;
  const entry = postcodeData?.find(e => e.zipCode === zip);
  const sub = entry?.subDistrictList.find(s => s.subDistrictName === name);
  if (!sub) { setDistrictProvince(prefix, '', ''); return; }
  const district = entry.districtList.find(d => d.districtId === sub.districtId);
  const province = entry.provinceList.find(p => p.provinceId === sub.provinceId);
  setDistrictProvince(prefix, district?.districtName || '', province?.provinceName || '');
}
```

Leave `onStageChange` where it is, between these and `openLeadModal` — Task 9 still needs it.

- [ ] **Step 8: Typecheck and syntax-check**

Run: `pnpm check`
Expected: `- 0 errors`. Note: `openLeadModal`/`saveLead` still reference `lead-gender`, `lead-postcode`, etc. at this point — Task 9 removes those. `pnpm check` won't catch this (it's plain inline JS, not type-checked), so this is expected to still be visually broken until Task 9; don't treat it as this task's failure.

Run: `awk '/<script is:inline>/{flag=1; next} /<\/script>/{flag=0} flag' src/pages/index.astro > /tmp/check.js && node --check /tmp/check.js && echo OK`
Expected: `OK`.

- [ ] **Step 9: Commit**

```bash
git add src/pages/index.astro
git commit -m "feat: add บริษัท page with company/contact CRUD

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 9: Deal modal — company/contact pickers; card rendering

**Files:**
- Modify: `src/pages/index.astro`

**Interfaces:**
- Consumes: `companies`, `contacts` globals from Task 8; `esc`, `nullableInput`, `api` helpers already in the file.
- Produces: `populateCompanySelect(id)`, `populateContactSelect(companyId, id)` — nothing later depends on these, but keep the names in case Phase 2 needs them.

- [ ] **Step 1: Replace the company/contact/phone/email/address fields in the lead modal's HTML**

Read `src/pages/index.astro` first (Task 8 changed it). Find the block starting at the "ชื่อบริษัท" input and ending right before "ใบรับรองที่สนใจ" — it currently contains: company text input, contact text input, phone input, email input, the "ข้อมูลส่วนตัว/ที่อยู่" header, and all the gender/occupation/postcode/sub-district/district/province/address1/address2 fields. Replace that *entire* block with:

```html
        <div class="col-span-2">
          <label class="field-label">บริษัท *</label>
          <select class="field-input" id="lead-company-id" required onchange="onLeadCompanyChange()">
            <option value="">-- เลือกบริษัท --</option>
          </select>
        </div>
        <div class="col-span-2 hidden" id="lead-new-company-wrap">
          <label class="field-label">ชื่อบริษัทใหม่</label>
          <input class="field-input" id="lead-new-company-name" placeholder="บริษัท ... จำกัด" />
        </div>
        <div>
          <label class="field-label">ผู้ติดต่อหลัก</label>
          <select class="field-input" id="lead-contact-id" onchange="onLeadContactChange()">
            <option value="">-- ไม่ระบุ --</option>
          </select>
        </div>
        <div class="hidden" id="lead-new-contact-wrap">
          <label class="field-label">ผู้ติดต่อใหม่</label>
          <input class="field-input mb-2" id="lead-new-contact-name" placeholder="ชื่อ-นามสกุล" />
          <input class="field-input" id="lead-new-contact-position" placeholder="ตำแหน่ง (ไม่บังคับ)" />
        </div>
```

(Editing phone/email/gender/occupation/address for a specific person now happens on the contact, via the บริษัท page's contact form from Task 8 — that's why they're gone from here.)

- [ ] **Step 2: Add the company/contact picker JS**

Find `function onStageChange() {` and insert this block immediately before it:

```js
function populateCompanySelect(selectedId) {
  const sel = document.getElementById('lead-company-id');
  const options = [...companies]
    .sort((a, b) => a.name.localeCompare(b.name, 'th'))
    .map(co => `<option value="${esc(co.id)}">${esc(co.name)}</option>`).join('');
  sel.innerHTML = '<option value="">-- เลือกบริษัท --</option>' + options + '<option value="__new__">+ เพิ่มบริษัทใหม่...</option>';
  sel.value = selectedId || '';
  onLeadCompanyChange();
}

function onLeadCompanyChange() {
  const companyId = document.getElementById('lead-company-id').value;
  document.getElementById('lead-new-company-wrap').classList.toggle('hidden', companyId !== '__new__');
  populateContactSelect(companyId === '__new__' ? '' : companyId, '');
}

function populateContactSelect(companyId, selectedId) {
  const sel = document.getElementById('lead-contact-id');
  const options = contacts.filter(c => c.company_id === companyId)
    .map(c => `<option value="${esc(c.id)}">${esc(c.full_name)}${c.position ? ` (${esc(c.position)})` : ''}</option>`).join('');
  sel.innerHTML = '<option value="">-- ไม่ระบุ --</option>' + options + '<option value="__new__">+ เพิ่มผู้ติดต่อใหม่...</option>';
  sel.value = selectedId || '';
  onLeadContactChange();
}

function onLeadContactChange() {
  const isNew = document.getElementById('lead-contact-id').value === '__new__';
  document.getElementById('lead-new-contact-wrap').classList.toggle('hidden', !isNew);
}

```

- [ ] **Step 3: Update `openLeadModal`'s populate logic**

Find the `if (id) { ... } else { ... }` block inside `openLeadModal`. Replace the lines that set `lead-contact`, `lead-phone`, `lead-email`, `lead-gender`, `lead-occupation`, `lead-address1`, `lead-address2`, `lead-postcode`, and the `populateSubDistricts(lead.postcode...)`/`setDistrictProvince(lead.district...)` calls with:

```js
    populateCompanySelect(lead.company_id);
    populateContactSelect(lead.company_id, lead.primary_contact_id || '');
```

(Keep every other line in that `if` branch — `lead-id`, `lead-company`... wait, `lead-company` no longer exists, so also delete that line — `setCertCheckboxes`, `lead-stage`, `lead-value`, `lead-quote-link`, `onStageChange()`, `lead-owner`, `lead-notes`.)

In the `else` branch (the "new lead" case), add one line — `populateCompanySelect('');` — anywhere before `deleteBtn.classList.add('hidden');`. Delete the now-nonexistent `populateSubDistricts('', '')` call there.

Further down, after the `document.querySelectorAll('#lead-form input:not([type=hidden])...').forEach(...)` disabling block, delete this now-broken fix-up (it references the `lead-sub-district`/`lead-postcode` ids just removed — leaving it in throws `Cannot read properties of null`):

```js
  // The above re-enables the sub-district dropdown unconditionally; it should stay disabled
  // until a postcode with sub-districts loaded is picked.
  const subSel = document.getElementById('lead-sub-district');
  if (editable) subSel.disabled = !postcodeData?.some(e => e.zipCode === document.getElementById('lead-postcode').value);
```

Also delete the now-unused `await loadPostcodeData();` line near the top of `openLeadModal` — the lead form no longer has a postcode field (Task 8 moved that concern to the contact form, which calls `loadPostcodeData()` itself from `openContactModal`).

- [ ] **Step 4: Rewrite `saveLead`**

Replace the whole `saveLead` function with:

```js
async function saveLead(e) {
  e.preventDefault();
  const id = document.getElementById('lead-id').value;

  let companyId = document.getElementById('lead-company-id').value;
  if (companyId === '__new__') {
    const name = document.getElementById('lead-new-company-name').value.trim();
    if (!name) { alert('กรุณากรอกชื่อบริษัทใหม่'); return; }
    try {
      const created = await api('/api/companies', { method: 'POST', body: JSON.stringify({ name }) });
      companies.push(created);
      companyId = created.id;
    } catch (err) {
      alert('เพิ่มบริษัทไม่สำเร็จ: ' + err.message);
      return;
    }
  }
  if (!companyId) { alert('กรุณาเลือกบริษัท'); return; }

  let contactId = document.getElementById('lead-contact-id').value;
  if (contactId === '__new__') {
    const full_name = document.getElementById('lead-new-contact-name').value.trim();
    if (!full_name) { alert('กรุณากรอกชื่อผู้ติดต่อใหม่'); return; }
    try {
      const created = await api('/api/contacts', {
        method: 'POST',
        body: JSON.stringify({
          company_id: companyId,
          full_name,
          position: document.getElementById('lead-new-contact-position').value,
        }),
      });
      contacts.push(created);
      contactId = created.id;
    } catch (err) {
      alert('เพิ่มผู้ติดต่อไม่สำเร็จ: ' + err.message);
      return;
    }
  }

  const data = {
    company_id: companyId,
    primary_contact_id: contactId || null,
    cert: getCertCheckboxes(),
    stage: document.getElementById('lead-stage').value,
    value: parseInt(document.getElementById('lead-value').value) || 0,
    // Only meaningful for the "เสนอราคา" stage, but harmless to keep if the stage changes later.
    quote_link: nullableInput('lead-quote-link'),
    notes: document.getElementById('lead-notes').value,
    ...ownerField('lead-owner'),
  };

  try {
    if (id) {
      await api(`/api/leads/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    } else {
      await api('/api/leads', { method: 'POST', body: JSON.stringify(data) });
    }
    leads = await api('/api/leads');
  } catch (err) {
    alert('บันทึกไม่สำเร็จ: ' + err.message);
    return;
  }

  closeLeadModal();
  renderAll();
}
```

- [ ] **Step 5: Update card and dashboard rendering to read the joined company/contact**

Find in `renderDashboard`:

```js
            <p class="text-sm font-medium truncate">${esc(l.company)}</p>
            <p class="text-xs text-ric-gray">${esc(l.cert?.join(', ')) || '—'} · ${esc(l.contact) || '—'}</p>
```

Replace with:

```js
            <p class="text-sm font-medium truncate">${esc(l.company?.name)}</p>
            <p class="text-xs text-ric-gray">${esc(l.cert?.join(', ')) || '—'} · ${esc(l.primary_contact?.full_name) || '—'}</p>
```

Find `function renderLeadCard(l) {` and replace its whole body:

```js
function renderLeadCard(l) {
  return `<div class="lead-card" draggable="${canEdit(l)}"
    data-id="${esc(l.id)}"
    ondragstart="onDragStart(event, '${esc(l.id)}')"
    ondragend="onDragEnd(event)"
    onclick="openLeadModal('${esc(l.id)}')">
    <p class="font-medium text-sm leading-tight mb-1">${esc(l.company?.name)}</p>
    <p class="text-xs text-ric-gray mb-2">${esc(l.cert?.join(', ')) || '—'}</p>
    <div class="flex items-center justify-between">
      <span class="text-xs text-ric-gray">${esc(l.primary_contact?.full_name) || '—'}${l.primary_contact?.position ? ` (${esc(l.primary_contact.position)})` : ''}</span>
      <span class="text-xs font-mono font-medium">${(l.value || 0).toLocaleString('th-TH')} ฿</span>
    </div>
    ${l.owner?.full_name ? `<p class="text-[10px] text-ric-gray/60 mt-1.5">👤 ${esc(l.owner.full_name)}</p>` : ''}
  </div>`;
}
```

- [ ] **Step 6: Typecheck and syntax-check**

Run: `pnpm check`
Expected: `- 0 errors`.

Run: `awk '/<script is:inline>/{flag=1; next} /<\/script>/{flag=0} flag' src/pages/index.astro > /tmp/check.js && node --check /tmp/check.js && echo OK`
Expected: `OK`.

- [ ] **Step 7: Commit**

```bash
git add src/pages/index.astro
git commit -m "feat: deal modal picks company/contact instead of free text

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 10: Phase 1 end-to-end verification

No source changes — this task only proves Phase 1 actually works end-to-end before Phase 2 builds on top of it. This project has no JS/TS test runner (confirm: `grep -A3 '"scripts"' package.json` has no `test` entry) — API verification here is curl against a running dev server, matching how every prior feature in this app was verified.

**Files:** none.

- [ ] **Step 1: Start a clean dev server**

```bash
cd /Users/iddh/Workspaces/supabase && supabase db reset
cd /Users/iddh/Workspaces/ric-crm
pkill -f "astro dev" 2>/dev/null; sleep 1
(pnpm dev > /tmp/dev.log 2>&1 &)
for i in $(seq 1 30); do curl -s -o /dev/null --max-time 2 http://localhost:4321/login && break; sleep 1; done
curl -s -o /dev/null -w "login page: %{http_code}\n" http://localhost:4321/login
```

Expected: `login page: 200`.

- [ ] **Step 2: Log in as root and exercise the new routes**

```bash
B=http://localhost:4321; H='Origin: http://localhost:4321'
JAR=$(mktemp)
curl -s -o /dev/null -w "login: %{http_code}\n" -c "$JAR" -H "$H" -X POST $B/api/auth/login \
  --data-urlencode 'email=root@ricroyal.co.th' --data-urlencode 'password=root!@Ric2026'

echo "-- list companies (expect the 8 seeded ones)"
curl -s -b "$JAR" $B/api/companies | python3 -c "import json,sys; print(len(json.load(sys.stdin)))"

echo "-- list leads, confirm company/primary_contact are joined objects"
curl -s -b "$JAR" $B/api/leads | python3 -c "
import json, sys
rows = json.load(sys.stdin)
assert len(rows) == 8, rows
assert all(r['company']['name'] for r in rows), 'a lead is missing its company join'
assert all(r['primary_contact']['full_name'] for r in rows), 'a lead is missing its contact join'
print('ok')
"

echo "-- create a company, a contact on it, and a deal using both"
CO=$(curl -s -b "$JAR" -H "$H" -H 'content-type: application/json' -X POST $B/api/companies -d '{"name":"e2e test co"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
CT=$(curl -s -b "$JAR" -H "$H" -H 'content-type: application/json' -X POST $B/api/contacts -d "{\"company_id\":\"$CO\",\"full_name\":\"e2e contact\",\"position\":\"QA\"}" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
LEAD=$(curl -s -b "$JAR" -H "$H" -H 'content-type: application/json' -X POST $B/api/leads -d "{\"company_id\":\"$CO\",\"primary_contact_id\":\"$CT\"}")
echo "$LEAD" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert d['company']['name'] == 'e2e test co', d
assert d['primary_contact']['full_name'] == 'e2e contact', d
print('ok')
"

echo "-- primary_contact_id from a DIFFERENT company is rejected"
OTHER_CO=$(curl -s -b "$JAR" -H "$H" -H 'content-type: application/json' -X POST $B/api/companies -d '{"name":"other co"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s -b "$JAR" -H "$H" -H 'content-type: application/json' -w " [%{http_code}]\n" -X POST $B/api/leads -d "{\"company_id\":\"$OTHER_CO\",\"primary_contact_id\":\"$CT\"}"

echo "-- cleanup"
LEAD_ID=$(echo "$LEAD" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s -b "$JAR" -H "$H" -X DELETE $B/api/leads/$LEAD_ID -o /dev/null
curl -s -b "$JAR" -H "$H" -X DELETE $B/api/contacts/$CT -o /dev/null
curl -s -b "$JAR" -H "$H" -X DELETE $B/api/companies/$CO -o /dev/null
curl -s -b "$JAR" -H "$H" -X DELETE $B/api/companies/$OTHER_CO -o /dev/null
```

Expected: company count `8`, leads join check prints `ok`, create-with-both prints `ok`, the cross-company `primary_contact_id` attempt returns `[400]`, cleanup calls all succeed (no output needed, just no errors).

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: ends with `[build] Complete!`, no errors.

- [ ] **Step 4: Manual UI smoke test**

Open `http://localhost:4321` in a browser, log in as root. Confirm: "บริษัท" nav item is visible and lists 8 companies; opening one shows its one contact and one deal; opening a deal from Pipeline shows the company/contact pickers populated with the right values; changing company clears and reloads the contact list; picking "+ เพิ่มบริษัทใหม่..." reveals a name field and, on save, creates the company and the deal in one step.

- [ ] **Step 5: No commit** — this task makes no changes.

---

## Phase 2 — Deal Log & Next Action

### Task 11: Migration — `leads.next_action*` and `activities.lead_id`

**Files:**
- Create: `supabase/migrations/20260924100000_leads_next_action.sql`
- Create: `supabase/migrations/20260924110000_activities_lead_log.sql`

**Interfaces:**
- Produces: `leads.next_action text null`, `leads.next_action_due date null`; `activities.lead_id uuid not null references leads on delete cascade`, `activities.old_stage text null`, `activities.new_stage text null`; `activities.type` check now also allows `'stage_change'`; `activities.company` is dropped.

- [ ] **Step 1: Write the leads migration**

```sql
-- supabase/migrations/20260924100000_leads_next_action.sql
alter table public.leads
  add column next_action text null,
  add column next_action_due date null;
```

- [ ] **Step 2: Write the activities migration**

```sql
-- supabase/migrations/20260924110000_activities_lead_log.sql
-- Activities become each deal's log: every row now belongs to exactly one lead. old_stage/
-- new_stage are populated only for type = 'stage_change' rows (written by the trigger in the
-- next migration); description still gets a plain-text summary for anyone querying raw SQL,
-- but the UI renders stage_change rows from old_stage/new_stage + the client-side STAGES
-- labels, not from description, to avoid keeping Thai stage labels in two places.
--
-- No existing activities to preserve link-wise (confirmed no production data) — seed.sql is
-- rewritten in a later task to match.
alter table public.activities
  add column lead_id uuid references public.leads (id) on delete cascade,
  add column old_stage text null,
  add column new_stage text null;

alter table public.activities alter column lead_id set not null;

alter table public.activities drop column company;

create index activities_lead_id_idx on public.activities (lead_id);

alter table public.activities drop constraint activities_type_check;
alter table public.activities
  add constraint activities_type_check check (type in ('call', 'email', 'meeting', 'note', 'stage_change'));
```

- [ ] **Step 3: Apply and confirm columns**

Run: `cd supabase && supabase db reset`
Expected: applies both new migrations with no error (the `seed.sql` step inside `db reset` WILL fail here — its `activities` insert still uses the now-dropped `company` column; that's expected until Task 16, and this step only needs the migrations themselves to apply cleanly. Confirm by checking the output includes `Applying migration 20260924110000_activities_lead_log.sql...` before any error line).

Run: `docker exec supabase_db_Workspaces psql -U postgres -c "\d public.activities" 2>&1 | grep -E "lead_id|old_stage|new_stage|company"`
Expected: shows `lead_id`, `old_stage`, `new_stage`; no `company` row.

- [ ] **Step 4: Commit**

```bash
cd /Users/iddh/Workspaces/supabase
git add migrations/20260924100000_leads_next_action.sql migrations/20260924110000_activities_lead_log.sql
git commit -m "feat: add leads.next_action, link activities to a lead

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 12: Migration — auto-log stage changes (trigger)

**Files:**
- Create: `supabase/migrations/20260924120000_log_stage_change_trigger.sql`

**Interfaces:**
- Consumes: `public.activities(lead_id, type, description, old_stage, new_stage, owner_id)` from Task 11.
- Produces: every `update` on `public.leads` that changes `stage` inserts exactly one `activities` row with `type = 'stage_change'`, regardless of which route or tool made the change.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260924120000_log_stage_change_trigger.sql
-- Auto-logs every stage change as an activities row. security definer + revoked execute (same
-- hardening as handle_new_user/reassign_owner) so it runs regardless of the caller's RLS grants —
-- a sales user dragging their own card still produces a log row even though they can't insert
-- into activities on someone else's behalf directly.
create function public.log_stage_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.stage is distinct from old.stage then
    insert into public.activities (lead_id, type, description, old_stage, new_stage, owner_id)
    values (
      new.id, 'stage_change', old.stage || ' → ' || new.stage, old.stage, new.stage,
      coalesce((select auth.uid()), new.owner_id)
    );
  end if;
  return new;
end;
$$;

revoke execute on function public.log_stage_change() from public, anon, authenticated;

create trigger leads_log_stage_change
  after update on public.leads
  for each row execute function public.log_stage_change();
```

- [ ] **Step 2: Apply it**

Run: `cd supabase && supabase db reset`
Expected: applies with no error (still fails at the `seed.sql` step for the same reason as Task 11 — that's fixed in Task 16).

- [ ] **Step 3: Commit**

```bash
git add migrations/20260924120000_log_stage_change_trigger.sql
git commit -m "feat: auto-log every lead stage change

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 13: Test the stage-change trigger

**Files:**
- Create: `supabase/tests/stage_change_log.test.sql`

**Interfaces:**
- Consumes: the trigger from Task 12.

- [ ] **Step 1: Write the test**

Follow the same `pg_temp.as_user`/`pg_temp.expect` pattern as the other two test files, with its own fixtures:

```sql
-- supabase/tests/stage_change_log.test.sql
-- Run: docker exec -i supabase_db_Workspaces psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/stage_change_log.test.sql
begin;

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                        confirmation_token, recovery_token, email_change, email_change_token_new)
select '00000000-0000-0000-0000-000000000000', v.id, 'authenticated', 'authenticated', v.email, '', now(),
       '{}', '{}', now(), now(), '', '', '', ''
from (values
  ('eeeeeeee-0000-4000-8000-00000000000a'::uuid, 'test-sales5@example.test')
) as v(id, email);

insert into public.companies (id, name, owner_id) values
  ('eeeeeeee-1000-4000-8000-000000000001', 'trigger test co', 'eeeeeeee-0000-4000-8000-00000000000a');
insert into public.leads (id, company_id, stage, owner_id) values
  ('eeeeeeee-2000-4000-8000-000000000001', 'eeeeeeee-1000-4000-8000-000000000001', 'new', 'eeeeeeee-0000-4000-8000-00000000000a');

create function pg_temp.as_user(uid uuid, stmt text) returns text
language plpgsql as $$
declare
  n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    execute stmt;
    get diagnostics n = row_count;
    reset role;
    return 'ok:' || n;
  exception when others then
    reset role;
    return 'error:' || sqlerrm;
  end;
end
$$;

create function pg_temp.expect(name text, actual text, wanted text) returns void
language plpgsql as $$
begin
  if actual not like wanted then
    raise exception 'FAIL %: got "%", wanted like "%"', name, actual, wanted;
  end if;
  raise notice 'pass  %', name;
end
$$;

\set sales '''eeeeeeee-0000-4000-8000-00000000000a'''

select pg_temp.expect('no log rows before any change',
  pg_temp.as_user(:sales, $$select 1 from public.activities where lead_id = 'eeeeeeee-2000-4000-8000-000000000001' having count(*) = 0$$), 'ok:0');

select pg_temp.expect('changing stage succeeds',
  pg_temp.as_user(:sales, $$update public.leads set stage = 'contacted' where id = 'eeeeeeee-2000-4000-8000-000000000001'$$), 'ok:1');
select pg_temp.expect('exactly one stage_change row was logged',
  pg_temp.as_user(:sales, $$select 1 from public.activities where lead_id = 'eeeeeeee-2000-4000-8000-000000000001' and type = 'stage_change' having count(*) = 1$$), 'ok:1');
select pg_temp.expect('the row records old and new stage correctly',
  pg_temp.as_user(:sales, $$select 1 from public.activities where lead_id = 'eeeeeeee-2000-4000-8000-000000000001' and old_stage = 'new' and new_stage = 'contacted' having count(*) = 1$$), 'ok:1');

select pg_temp.expect('editing notes only does not log a stage change',
  pg_temp.as_user(:sales, $$update public.leads set notes = 'just a note' where id = 'eeeeeeee-2000-4000-8000-000000000001'$$), 'ok:1');
select pg_temp.expect('still exactly one stage_change row',
  pg_temp.as_user(:sales, $$select 1 from public.activities where lead_id = 'eeeeeeee-2000-4000-8000-000000000001' and type = 'stage_change' having count(*) = 1$$), 'ok:1');

select pg_temp.expect('setting the same stage again does not log a second row',
  pg_temp.as_user(:sales, $$update public.leads set stage = 'contacted' where id = 'eeeeeeee-2000-4000-8000-000000000001'$$), 'ok:1');
select pg_temp.expect('still exactly one stage_change row after a no-op stage set',
  pg_temp.as_user(:sales, $$select 1 from public.activities where lead_id = 'eeeeeeee-2000-4000-8000-000000000001' and type = 'stage_change' having count(*) = 1$$), 'ok:1');

select pg_temp.expect('a second real stage change adds a second row',
  pg_temp.as_user(:sales, $$update public.leads set stage = 'quoted' where id = 'eeeeeeee-2000-4000-8000-000000000001'$$), 'ok:1');
select pg_temp.expect('now two stage_change rows',
  pg_temp.as_user(:sales, $$select 1 from public.activities where lead_id = 'eeeeeeee-2000-4000-8000-000000000001' and type = 'stage_change' having count(*) = 2$$), 'ok:1');

do $$ begin raise notice 'ALL STAGE CHANGE LOG TESTS PASSED'; end $$;

rollback;
```

- [ ] **Step 2: Run it**

Run: `docker exec -i supabase_db_Workspaces psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/stage_change_log.test.sql 2>&1 | grep -E "FAIL|ERROR|PASSED"`
Expected: all `pass`, ends with `NOTICE:  ALL STAGE CHANGE LOG TESTS PASSED`.

- [ ] **Step 3: Commit**

```bash
git add tests/stage_change_log.test.sql
git commit -m "test: cover the stage-change log trigger

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 14: Zod schemas — `next_action*`, `activityCreate.lead_id`

**Files:**
- Modify: `src/lib/schemas.ts`

**Interfaces:**
- Produces: `leadInput` gains `next_action`, `next_action_due`; `activityCreate` requires `lead_id`, drops `company`.

- [ ] **Step 1: Add next_action fields to `leadInput`/`leadCreate`**

Read the file first. In `leadInput`, add two fields right after `quote_link: optionalUrl(500),`:

```ts
  next_action: optionalText(200),
  next_action_due: z.union([z.null(), isoDate]).optional(),
```

In `leadCreate`'s `.partial({ ... })` call, add `next_action: true, next_action_due: true,` to the list (alongside the existing `quote_link: true,`).

- [ ] **Step 2: Update `activityCreate`**

Replace:

```ts
export const activityCreate = z.object({
  type: z.enum(['call', 'email', 'meeting', 'note']).default('note'),
  company: text(200).default(''),
  description: text(5000).min(1),
  date: isoDate.optional(),
  followup: z.union([isoDate, z.literal('')]).optional(),
  owner_id: z.uuid().optional(),
});
```

with:

```ts
export const activityCreate = z.object({
  lead_id: z.uuid(),
  // stage_change is written only by the database trigger (security definer, bypasses this
  // schema entirely) — never accept it from a client request.
  type: z.enum(['call', 'email', 'meeting', 'note']).default('note'),
  description: text(5000).min(1),
  date: isoDate.optional(),
  followup: z.union([isoDate, z.literal('')]).optional(),
  owner_id: z.uuid().optional(),
});
```

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: errors will appear in `src/pages/api/activities.ts` (still references `company`) — that's fixed in Task 15. Confirm `schemas.ts` itself reports no error.

- [ ] **Step 4: Commit**

```bash
git add src/lib/schemas.ts
git commit -m "feat: add next_action to lead schema, require lead_id on activities

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 15: API — activities scoped to a lead, plus a delete route

**Files:**
- Modify: `src/pages/api/activities.ts`
- Create: `src/pages/api/activities/[id].ts`

**Interfaces:**
- Consumes: updated `activityCreate` from Task 14.
- Produces: `GET /api/activities` (all, newest first, each row includes `lead: {company: {name}}`), `GET /api/activities?lead_id=<uuid>` (one deal's timeline), `POST /api/activities` (requires `lead_id`), `DELETE /api/activities/:id` (root only — activities previously had no delete route at all; root's "can do everything" now covers a mis-logged manual entry too, matching the `leads`/`renewals`/`companies`/`contacts` delete pattern).

- [ ] **Step 1: Rewrite `src/pages/api/activities.ts`**

```ts
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
```

- [ ] **Step 2: Write `src/pages/api/activities/[id].ts`**

```ts
import type { APIRoute } from 'astro';
import { json, fail, dbError } from '@/lib/api';
import { requireRoot } from '@/lib/auth';
import { uuidParam } from '@/lib/schemas';

export const prerender = false;

export const DELETE: APIRoute = async ({ locals, params }) => {
  // RLS only lets root delete, but answer 403 (not a misleading 404) for everyone else.
  const denied = await requireRoot(locals);
  if (denied) return denied;

  const id = uuidParam.safeParse(params.id);
  if (!id.success) return fail('Invalid id', 400);

  const { data, error } = await locals.supabase.from('activities').delete().eq('id', id.data).select('id');
  if (error) return dbError(error);
  if (data.length === 0) return fail('Not found', 404);
  return json({ ok: true });
};
```

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: `- 0 errors`.

- [ ] **Step 4: Commit**

```bash
git add src/pages/api/activities.ts "src/pages/api/activities/[id].ts"
git commit -m "feat: activities scoped to a lead, root can delete one

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 16: Seed data — point activities at leads, add a couple of next_action examples

**Files:**
- Modify: `supabase/seed.sql`

**Interfaces:** none — data only.

- [ ] **Step 1: Replace the activities insert block**

Read `supabase/seed.sql` first (Task 7 already changed it). Replace the `-- ── Activities: every type, some with upcoming follow-ups ──` block with:

```sql
-- ── Activities: every type, linked to the lead it's about ───────────────────
-- The old seed had a 6th row with no company (a general team-meeting note) — that no longer
-- fits the model now that every activity belongs to a specific lead, so it's dropped.
insert into public.activities (id, lead_id, type, description, date, followup, owner_id)
select v.id, v.lead_id, v.type, v.description, v.date, v.followup, o.id
from (values
  ('22222222-0000-4000-8000-000000000001'::uuid, '11111111-0000-4000-8000-000000000001'::uuid, 'call',    'โทรแนะนำบริการ ลูกค้าสนใจ ISO 22000 สำหรับโรงงานใหม่', current_date - 1, current_date + 3),
  ('22222222-0000-4000-8000-000000000002'::uuid, '11111111-0000-4000-8000-000000000002'::uuid, 'email',   'ส่งโบรชัวร์และขั้นตอนการขอ ISO 9001',                 current_date - 2, current_date + 5),
  ('22222222-0000-4000-8000-000000000003'::uuid, '11111111-0000-4000-8000-000000000003'::uuid, 'meeting', 'ประชุมที่สำนักงานลูกค้า นำเสนอแผนงานและใบเสนอราคา',  current_date - 4, null),
  ('22222222-0000-4000-8000-000000000004'::uuid, '11111111-0000-4000-8000-000000000004'::uuid, 'call',    'ต่อรองราคา ลูกค้าขอลด 10% ต้องหารือหัวหน้า',           current_date,     current_date + 2),
  ('22222222-0000-4000-8000-000000000005'::uuid, '11111111-0000-4000-8000-000000000005'::uuid, 'note',    'ลูกค้าเซ็นสัญญาแล้ว ส่งต่อทีมตรวจประเมิน',              current_date - 6, null)
) as v(id, lead_id, type, description, date, followup)
cross join (select id from public.profiles order by created_at limit 1) as o
on conflict (id) do nothing;

-- ── next_action on a couple of leads, so the Pipeline card box has something to show ────────
update public.leads set next_action = 'ส่งใบเสนอราคาที่แก้ไขแล้ว', next_action_due = current_date + 2
where id = '11111111-0000-4000-8000-000000000003';
update public.leads set next_action = 'โทรติดตามผลการตัดสินใจ', next_action_due = current_date + 5
where id = '11111111-0000-4000-8000-000000000004';
```

- [ ] **Step 2: Reset and confirm**

Run: `cd supabase && supabase db reset`
Expected: `Finished supabase db reset on branch main.` with no error — this is the first time since Task 11 that a full reset succeeds end-to-end.

Run: `docker exec supabase_db_Workspaces psql -U postgres -c "select count(*) from public.activities where type = 'stage_change';"`
Expected: `0` — the trigger only fires on `update`, and seed data is inserted via plain `insert`, so no stage_change rows exist yet (that's expected; Task 20's manual test creates one via an actual `PUT`).

- [ ] **Step 3: Commit**

```bash
cd /Users/iddh/Workspaces/supabase
git add seed.sql
git commit -m "feat: seed activities linked to leads, add next_action examples

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 17: `next_action`/`next_action_due` fields and the Pipeline card reminder box

**Files:**
- Modify: `src/pages/index.astro`

**Interfaces:**
- Consumes: `daysUntil(dateStr)` (already defined, used by renewals) for the overdue calculation.

- [ ] **Step 1: Add the fields to the lead form**

Find (added in an earlier session, right after the Stage/value fields):

```html
        <div class="col-span-2 hidden" id="lead-quote-link-wrap">
          <label class="field-label">ลิงก์ใบเสนอราคา</label>
          <input class="field-input" id="lead-quote-link" type="url" placeholder="https://..." />
        </div>
```

Insert immediately after it:

```html
        <div>
          <label class="field-label">งานถัดไป</label>
          <input class="field-input" id="lead-next-action" placeholder="เช่น ส่งใบเสนอราคา, โทรติดตาม" />
        </div>
        <div>
          <label class="field-label">วันครบกำหนด</label>
          <input class="field-input" id="lead-next-action-due" type="date" />
        </div>
```

- [ ] **Step 2: Populate and save it**

In `openLeadModal`'s edit branch, find `document.getElementById('lead-quote-link').value = lead.quote_link || '';` and add right after it:

```js
    document.getElementById('lead-next-action').value = lead.next_action || '';
    document.getElementById('lead-next-action-due').value = lead.next_action_due || '';
```

In `saveLead`'s `data` object, find `quote_link: nullableInput('lead-quote-link'),` and add right after it:

```js
    next_action: nullableInput('lead-next-action'),
    next_action_due: nullableInput('lead-next-action-due'),
```

- [ ] **Step 3: Show it on the Pipeline card**

Replace the whole `renderLeadCard` function (last rewritten in Task 9) with:

```js
function renderLeadCard(l) {
  const overdue = l.next_action_due && daysUntil(l.next_action_due) < 0;
  const dueLabel = l.next_action_due
    ? new Date(l.next_action_due).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })
    : '';
  const nextActionHtml = l.next_action
    ? `<p class="text-[11px] mt-2 px-2 py-1 rounded-md ${overdue ? 'bg-red-50 text-ric-red' : 'bg-amber-50 text-amber-700'}">🔔 ${esc(l.next_action)}${dueLabel ? ` — ${overdue ? 'เลยกำหนด' : 'ครบกำหนด'} ${dueLabel}` : ''}</p>`
    : '';
  return `<div class="lead-card" draggable="${canEdit(l)}"
    data-id="${esc(l.id)}"
    ondragstart="onDragStart(event, '${esc(l.id)}')"
    ondragend="onDragEnd(event)"
    onclick="openLeadModal('${esc(l.id)}')">
    <p class="font-medium text-sm leading-tight mb-1">${esc(l.company?.name)}</p>
    <p class="text-xs text-ric-gray mb-2">${esc(l.cert?.join(', ')) || '—'}</p>
    <div class="flex items-center justify-between">
      <span class="text-xs text-ric-gray">${esc(l.primary_contact?.full_name) || '—'}${l.primary_contact?.position ? ` (${esc(l.primary_contact.position)})` : ''}</span>
      <span class="text-xs font-mono font-medium">${(l.value || 0).toLocaleString('th-TH')} ฿</span>
    </div>
    ${nextActionHtml}
    ${l.owner?.full_name ? `<p class="text-[10px] text-ric-gray/60 mt-1.5">👤 ${esc(l.owner.full_name)}</p>` : ''}
  </div>`;
}
```

- [ ] **Step 4: Typecheck and syntax-check**

Run: `pnpm check`
Expected: `- 0 errors`.

Run: `awk '/<script is:inline>/{flag=1; next} /<\/script>/{flag=0} flag' src/pages/index.astro > /tmp/check.js && node --check /tmp/check.js && echo OK`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add src/pages/index.astro
git commit -m "feat: next_action field and Pipeline card reminder box

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 18: Deal detail — "ข้อมูล"/"Log" tabs on the lead modal

The lead modal (`#modal-lead`) gains a second tab showing that deal's activity timeline (auto stage-change rows plus manually-added ones) with a quick-add form. The Log tab is only usable once a lead exists — a brand-new, unsaved lead has no `lead_id` to attach entries to.

**Files:**
- Modify: `src/pages/index.astro`

**Interfaces:**
- Consumes: `activities` global (already loaded in full by `loadAll`), `STAGES`, `ACT_TYPE_LABEL`, `api`, `esc`.
- Produces: `currentLeadId` global; `switchLeadTab(tab)`, `renderLeadLog()`, `saveLeadActivity(e)`.

- [ ] **Step 1: Add tab buttons between the modal header and the form**

Find (the lead modal's header, closing `</div>` right before `<form id="lead-form"`):

```html
      </button>
    </div>
    <form id="lead-form" class="p-5 space-y-4" onsubmit="saveLead(event)">
```

Replace with:

```html
      </button>
    </div>
    <div class="flex border-b border-gray-100 px-5">
      <button type="button" onclick="switchLeadTab('info')" id="lead-tab-btn-info" class="px-3 py-2.5 text-sm font-medium border-b-2 border-ric-red text-ric-red">ข้อมูล</button>
      <button type="button" onclick="switchLeadTab('log')" id="lead-tab-btn-log" class="px-3 py-2.5 text-sm font-medium border-b-2 border-transparent text-ric-gray hover:text-ric-black hidden">Log</button>
    </div>
    <div id="lead-tab-info">
    <form id="lead-form" class="p-5 space-y-4" onsubmit="saveLead(event)">
```

- [ ] **Step 2: Close the new wrapper div and add the Log tab's content**

Find, at the end of the lead modal (right before `</div></div>` that closes `.modal-box`/`#modal-lead`):

```html
      </div>
    </form>
  </div>
</div>

<!-- MODAL: Activity -->
```

Replace with:

```html
      </div>
    </form>
    </div>
    <div id="lead-tab-log" class="hidden p-5">
      <div id="lead-log-list" class="space-y-3 mb-4 max-h-64 overflow-y-auto"></div>
      <form onsubmit="saveLeadActivity(event)" class="border-t border-gray-100 pt-4 space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <select class="field-input" id="lead-act-type">
            <option value="call">📞 โทรศัพท์</option>
            <option value="email">✉️ อีเมล</option>
            <option value="meeting">🤝 ประชุม</option>
            <option value="note">📝 บันทึก</option>
          </select>
          <input class="field-input" id="lead-act-followup" type="date" />
        </div>
        <textarea class="field-input h-16 resize-none" id="lead-act-description" required placeholder="บันทึกใหม่..."></textarea>
        <button type="submit" class="btn-primary w-full">บันทึก</button>
      </form>
    </div>
  </div>
</div>

<!-- MODAL: Activity -->
```

- [ ] **Step 3: Add `currentLeadId`, tab switching, log rendering, and the quick-add form**

Find `let currentCompanyId = null;` (added in Task 8) and add a line after it:

```js
let currentLeadId = null;
```

Find `function onStageChange() {` and insert this block immediately before it:

```js
function setTabButtonActive(btnId, active) {
  const btn = document.getElementById(btnId);
  btn.classList.toggle('border-ric-red', active);
  btn.classList.toggle('text-ric-red', active);
  btn.classList.toggle('border-transparent', !active);
  btn.classList.toggle('text-ric-gray', !active);
}

function switchLeadTab(tab) {
  document.getElementById('lead-tab-info').classList.toggle('hidden', tab !== 'info');
  document.getElementById('lead-tab-log').classList.toggle('hidden', tab !== 'log');
  setTabButtonActive('lead-tab-btn-info', tab === 'info');
  setTabButtonActive('lead-tab-btn-log', tab === 'log');
  if (tab === 'log') renderLeadLog();
}

function renderLeadLog() {
  const entries = activities
    .filter(a => a.lead_id === currentLeadId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  document.getElementById('lead-log-list').innerHTML = entries.length
    ? entries.map(a => {
        if (a.type === 'stage_change') {
          const oldLabel = STAGES.find(s => s.id === a.old_stage)?.label || a.old_stage;
          const newLabel = STAGES.find(s => s.id === a.new_stage)?.label || a.new_stage;
          return `<div class="text-xs text-ric-gray flex items-center gap-2">
            <span class="font-mono">${esc(a.date)}</span>
            <span>เปลี่ยนสถานะ: ${esc(oldLabel)} → ${esc(newLabel)}</span>
          </div>`;
        }
        return `<div class="text-sm border-b border-gray-50 pb-2">
          <div class="flex items-center gap-2 text-xs text-ric-gray mb-1">
            <span class="bg-gray-100 px-2 py-0.5 rounded-sm">${esc(ACT_TYPE_LABEL[a.type] || a.type)}</span>
            <span class="font-mono">${esc(a.date)}</span>
          </div>
          <p>${esc(a.description)}</p>
          ${a.followup ? `<p class="text-xs text-amber-600 mt-1">🔔 นัดติดตาม: ${esc(a.followup)}</p>` : ''}
        </div>`;
      }).join('')
    : '<p class="text-sm text-ric-gray text-center py-6">ยังไม่มีบันทึก</p>';
}

async function saveLeadActivity(e) {
  e.preventDefault();
  const data = {
    lead_id: currentLeadId,
    type: document.getElementById('lead-act-type').value,
    description: document.getElementById('lead-act-description').value,
    followup: document.getElementById('lead-act-followup').value,
  };
  try {
    activities.unshift(await api('/api/activities', { method: 'POST', body: JSON.stringify(data) }));
  } catch (err) {
    alert('บันทึกไม่สำเร็จ: ' + err.message);
    return;
  }
  document.getElementById('lead-act-description').value = '';
  document.getElementById('lead-act-followup').value = '';
  renderLeadLog();
}

```

- [ ] **Step 4: Wire `currentLeadId` and tab visibility into `openLeadModal`**

Find, near the top of `openLeadModal` (right after `let editable = true;`):

```js
  let editable = true;
```

Replace with:

```js
  let editable = true;
  currentLeadId = id;
  switchLeadTab('info');
  document.getElementById('lead-tab-btn-log').classList.toggle('hidden', !id);
```

- [ ] **Step 5: Typecheck and syntax-check**

Run: `pnpm check`
Expected: `- 0 errors`.

Run: `awk '/<script is:inline>/{flag=1; next} /<\/script>/{flag=0} flag' src/pages/index.astro > /tmp/check.js && node --check /tmp/check.js && echo OK`
Expected: `OK`.

- [ ] **Step 6: Commit**

```bash
git add src/pages/index.astro
git commit -m "feat: two-tab deal detail — info + timeline log

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 19: "กิจกรรม" becomes a read-only, all-deals feed

Creating an activity no longer happens from this tab (it requires a `lead_id`, which only exists in the context of an open deal — Task 18's Log tab). This tab becomes a read-only feed; each row links to its deal.

**Files:**
- Modify: `src/pages/index.astro`

- [ ] **Step 1: Remove the "บันทึกกิจกรรม" button**

Find:

```html
  <!-- ACTIVITIES -->
  <div id="view-activities" class="hidden p-6">
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-xl font-semibold">กิจกรรมและติดตาม</h1>
      <button onclick="openActivityModal()" class="btn-primary flex items-center gap-2">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
        บันทึกกิจกรรม
      </button>
    </div>
    <div id="activities-list" class="space-y-3"></div>
  </div>
```

Replace with:

```html
  <!-- ACTIVITIES -->
  <div id="view-activities" class="hidden p-6">
    <div class="mb-6">
      <h1 class="text-xl font-semibold">กิจกรรมและติดตาม</h1>
      <p class="text-ric-gray text-sm mt-0.5">ทุกดีล อ่านอย่างเดียว — กดแถวเพื่อเปิดดีลนั้น เพิ่มบันทึกใหม่ได้จากในดีล (แท็บ Log)</p>
    </div>
    <div id="activities-list" class="space-y-3"></div>
  </div>
```

- [ ] **Step 2: Delete the standalone activity modal**

Delete the entire `<!-- MODAL: Activity -->` ... `</div>` block (from `<div id="modal-activity" ...>` through its matching closing `</div>`) — it's fully superseded by Task 18's Log tab.

- [ ] **Step 3: Rewrite `renderActivities`, delete the old modal's JS functions**

Replace the whole `renderActivities` function with:

```js
function renderActivities() {
  const sorted = [...activities].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  document.getElementById('activities-list').innerHTML = sorted.length
    ? sorted.map(a => {
        const companyName = a.lead?.company?.name || '—';
        if (a.type === 'stage_change') {
          const oldLabel = STAGES.find(s => s.id === a.old_stage)?.label || a.old_stage;
          const newLabel = STAGES.find(s => s.id === a.new_stage)?.label || a.new_stage;
          return `<div class="bg-white rounded-xl p-4 shadow-xs border border-gray-100 cursor-pointer hover:bg-gray-50" onclick="openDeal('${esc(a.lead_id)}')">
            <div class="flex items-center gap-2 text-xs text-ric-gray">
              <span class="font-mono">${esc(a.date)}</span>
              <span>· ${esc(companyName)}</span>
            </div>
            <p class="text-sm mt-1">เปลี่ยนสถานะ: ${esc(oldLabel)} → ${esc(newLabel)}</p>
          </div>`;
        }
        return `<div class="bg-white rounded-xl p-4 shadow-xs border border-gray-100 cursor-pointer hover:bg-gray-50" onclick="openDeal('${esc(a.lead_id)}')">
          <div class="flex-1">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs bg-gray-100 px-2 py-0.5 rounded-sm">${esc(ACT_TYPE_LABEL[a.type] || a.type)}</span>
              <span class="text-xs font-mono text-ric-gray">${esc(a.date)}</span>
              <span class="text-xs text-ric-gray">· ${esc(companyName)}</span>
            </div>
            <p class="text-sm">${esc(a.description)}</p>
            ${a.followup ? `<p class="text-xs text-amber-600 mt-1">🔔 นัดติดตาม: ${esc(a.followup)}</p>` : ''}
            ${a.owner?.full_name ? `<p class="text-xs text-ric-gray/60 mt-1">👤 ${esc(a.owner.full_name)}</p>` : ''}
          </div>
        </div>`;
      }).join('')
    : '<div class="bg-white rounded-xl p-8 text-center text-sm text-ric-gray shadow-xs border border-gray-100">ยังไม่มีกิจกรรม</div>';
}
```

Delete the three now-unused functions `openActivityModal`, `closeActivityModal`, and the original standalone `saveActivity` (the one that read `act-type`/`act-date`/`act-company`/`act-description`/`act-followup`/`act-owner` — not `saveLeadActivity` from Task 18, which stays).

- [ ] **Step 4: Typecheck and syntax-check**

Run: `pnpm check`
Expected: `- 0 errors`.

Run: `awk '/<script is:inline>/{flag=1; next} /<\/script>/{flag=0} flag' src/pages/index.astro > /tmp/check.js && node --check /tmp/check.js && echo OK`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add src/pages/index.astro
git commit -m "feat: กิจกรรม tab becomes a read-only all-deals feed

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 20: Phase 2 end-to-end verification

**Files:** none.

- [ ] **Step 1: Clean reset and start**

```bash
cd /Users/iddh/Workspaces/supabase && supabase db reset
cd /Users/iddh/Workspaces/ric-crm
pkill -f "astro dev" 2>/dev/null; sleep 1
(pnpm dev > /tmp/dev.log 2>&1 &)
for i in $(seq 1 30); do curl -s -o /dev/null --max-time 2 http://localhost:4321/login && break; sleep 1; done
```

Expected: `supabase db reset` ends with `Finished supabase db reset on branch main.` and no error this time (Task 16 fixed the seed).

- [ ] **Step 2: Verify the trigger fires through the real API, and the feed/filter work**

```bash
B=http://localhost:4321; H='Origin: http://localhost:4321'
JAR=$(mktemp)
curl -s -o /dev/null -w "login: %{http_code}\n" -c "$JAR" -H "$H" -X POST $B/api/auth/login \
  --data-urlencode 'email=root@ricroyal.co.th' --data-urlencode 'password=root!@Ric2026'

LEAD=$(curl -s -b "$JAR" $B/api/leads | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['id'])")

echo "-- before: no activities for this lead"
curl -s -b "$JAR" "$B/api/activities?lead_id=$LEAD" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))"

echo "-- change its stage via PUT"
curl -s -b "$JAR" -H "$H" -H 'content-type: application/json' -w " [%{http_code}]\n" -X PUT $B/api/leads/$LEAD -d '{"stage":"negotiating"}'

echo "-- after: one stage_change activity, correct old/new stage"
curl -s -b "$JAR" "$B/api/activities?lead_id=$LEAD" | python3 -c "
import json, sys
rows = json.load(sys.stdin)
assert len(rows) == 1, rows
assert rows[0]['type'] == 'stage_change', rows
assert rows[0]['new_stage'] == 'negotiating', rows
assert rows[0]['lead']['company']['name'], rows
print('ok')
"

echo "-- client cannot POST type=stage_change directly"
curl -s -b "$JAR" -H "$H" -H 'content-type: application/json' -w " [%{http_code}]\n" -X POST $B/api/activities -d "{\"lead_id\":\"$LEAD\",\"type\":\"stage_change\",\"description\":\"x\"}" | head -c 200; echo

echo "-- manual note via the API"
NOTE=$(curl -s -b "$JAR" -H "$H" -H 'content-type: application/json' -X POST $B/api/activities -d "{\"lead_id\":\"$LEAD\",\"type\":\"note\",\"description\":\"e2e note\"}")
NOTE_ID=$(echo "$NOTE" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "-- non-root cannot delete it (create+check as root is enough here: assert route exists and is root-gated)"
curl -s -b "$JAR" -H "$H" -w " [%{http_code}]\n" -X DELETE $B/api/activities/$NOTE_ID

echo "-- next_action round-trips"
curl -s -b "$JAR" -H "$H" -H 'content-type: application/json' -X PUT $B/api/leads/$LEAD -d '{"next_action":"ส่งใบเสนอราคา","next_action_due":"2026-12-01"}' -o /dev/null
curl -s -b "$JAR" $B/api/leads | python3 -c "
import json, sys
rows = json.load(sys.stdin)
lead = next(r for r in rows if r['id'] == '$LEAD')
assert lead['next_action'] == 'ส่งใบเสนอราคา', lead
assert lead['next_action_due'] == '2026-12-01', lead
print('ok')
"

echo "-- revert the test stage change (leaves seed data as seed.sql defined it)"
curl -s -b "$JAR" -H "$H" -H 'content-type: application/json' -X PUT $B/api/leads/$LEAD -d '{"stage":"new","next_action":null,"next_action_due":null}' -o /dev/null
```

Expected: before-count `0`; PUT returns `[200]`; after-check prints `ok`; the direct `stage_change` POST returns `[400]` with a validation error naming `type`; the DELETE of the manual note returns `[200]` (root); next_action round-trip prints `ok`.

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: ends with `[build] Complete!`.

- [ ] **Step 4: Manual UI smoke test**

Open `http://localhost:4321`, log in as root. On Pipeline, open a deal that has `next_action` set from seed (`บริษัท กรีนเทค เอ็นเนอร์ยี่ จำกัด` or `โรงพยาบาลเอกชัย`) and confirm the 🔔 box shows on its card. Open that deal, click the "Log" tab, confirm it lists the seeded manual entry. Drag a card to a different column, reopen it, confirm a new "เปลี่ยนสถานะ: ... → ..." line appears in the Log tab without you doing anything else. Go to "กิจกรรม", confirm the same entries appear there with a company name, and clicking one opens that deal on Pipeline.

- [ ] **Step 5: No commit** — this task makes no changes.

## Known limitations (explicitly not built)

- **Contact modal doesn't grey out for non-owners.** The lead modal disables its inputs when `!canEdit(lead)`; the contact modal (Task 8) doesn't do the same. RLS still blocks the write server-side (a sales user editing someone else's contact gets a generic "Database error" on save, not a friendly pre-emptive read-only state) — correct but rough. Worth a follow-up if it comes up in practice.
- **No pagination anywhere.** Companies/contacts/leads/activities are all loaded in full on login, same as every existing list in this app. Fine at current scale; would need revisiting well before hundreds of companies.
- **`renewals.company` stays free text**, per the approved spec — not linked to `companies`.

## Self-review notes

Checked against the spec section by section: every requirement (company↔deal one-to-many, contacts shared per company, immediate drag + auto-log, separate `next_action` field, no data migration needed, personal fields moved to contacts, กิจกรรม as a read-only linking feed, renewals left untouched) maps to at least one task above. Placeholder scan found nothing (`TBD`/`TODO`/"similar to Task N"/etc.). Cross-task name and shape consistency was checked by grep: `renderLeadCard` (rewritten in Task 9, then Task 17 — confirmed the two bodies match except for the added reminder box), `openLeadModal`'s edit points (Task 9 removes the postcode fix-up and its trailing `await loadPostcodeData()`, Task 18 then edits the line immediately after `let editable = true;` — confirmed that line's neighbourhood is what Task 9 leaves behind), and every new helper's define/call-site pairs (`populateCompanySelect`, `populateContactSelect`, `openDeal`, `currentCompanyId`, `currentLeadId`, `switchLeadTab`, `renderLeadLog`, `saveLeadActivity`, the four re-parameterised postcode functions) — none were orphaned.
