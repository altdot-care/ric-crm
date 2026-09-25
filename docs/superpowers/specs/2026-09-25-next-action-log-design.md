# Next-Action Log Design

**Status:** Approved for planning
**Date:** 2026-09-25

## Problem

Each lead currently has a single `next_action` (text) + `next_action_due` (date) pair,
directly on the `leads` row. Recording a new next action overwrites whatever was there
before — there is no history, and a salesperson cannot track two upcoming actions on the
same deal at once (e.g. "ส่งใบเสนอราคาที่แก้ไขแล้ว" due Friday *and* "โทรติดตามผล" due next
week). The Pipeline card's 🔔 reminder reads this single field directly.

## Goal

Replace the single mutable field with an append-only log of next-action line items per
lead. Each item can be added independently, marked done, and the Pipeline card's reminder
picks the most urgent open item automatically. This mirrors how the stage-change log
already replaced a similar single-field pattern earlier in this project.

## Data model

New table `next_actions` in the `supabase` repo, same shape and RLS convention as
`activities`:

```sql
create table public.next_actions (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid not null references public.leads (id) on delete cascade,
  description  text not null check (length(btrim(description)) > 0),
  due_date     date null,
  completed_at timestamptz null,
  owner_id     uuid not null default auth.uid() references public.profiles (id),
  created_at   timestamptz not null default now()
);

create index next_actions_lead_id_idx on public.next_actions (lead_id);
create index next_actions_owner_id_idx on public.next_actions (owner_id);

alter table public.next_actions enable row level security;

create policy "next_actions_select" on public.next_actions
  for select to authenticated using (true);
create policy "next_actions_insert" on public.next_actions
  for insert to authenticated with check (owner_id = (select auth.uid()) or (select public.is_admin()));
create policy "next_actions_update" on public.next_actions
  for update to authenticated
  using (owner_id = (select auth.uid()) or (select public.is_admin()))
  with check (owner_id = (select auth.uid()) or (select public.is_admin()));
create policy "next_actions_delete" on public.next_actions
  for delete to authenticated using ((select public.is_root()));
```

"Marking done" is a plain `update` (`completed_at = now()`), governed by the same
owner/admin policy as any other edit — no new RLS shape needed. Deleting a mistakenly
added item is root-only, matching the project-wide "only root deletes" rule; a regular
user who adds a wrong item just marks it done or leaves it, same tradeoff the app already
makes for other logs.

### Migration & backfill

One migration:
1. Create `next_actions` + RLS as above.
2. Backfill: `insert into public.next_actions (lead_id, description, due_date, owner_id)
   select id, next_action, next_action_due, owner_id from public.leads where next_action
   is not null and btrim(next_action) <> ''` — carries the two seed leads' existing next
   actions forward as the first line item instead of losing them.
3. `alter table public.leads drop column next_action, drop column next_action_due;`

All three steps happen in one migration file, since the backfill is a mechanical,
non-destructive step of the same restructuring, not a separate concern.

## API (ric-crm repo)

- `src/pages/api/next-actions.ts` — `GET` (optional `?lead_id=` filter), `POST`.
- `src/pages/api/next-actions/[id].ts` — `PUT` (edit description/due_date, or set/clear
  `completed_at`), `DELETE` (root-only).

Same `parseBody → dbError → json` shape as every other route in this app. Zod schemas
`nextActionCreate`/`nextActionUpdate` added to `schemas.ts`, following the same
`text()`/`optionalText()`/`isoDate` helpers already in use there.

## UI

**Lead modal, ข้อมูล tab.** The current `lead-next-action` (text input) and
`lead-next-action-due` (date input) fields are removed. In their place: a compact list of
this lead's next-action items — each row a checkbox, the description, and the due date
(checked items shown struck-through/greyed, matching a standard todo-list treatment) —
plus a small add-row beneath it (text input + date input + "+" button), visually in the
same family as the Log tab's existing quick-add form. New client state array
`nextActions` (all rows across all leads, loaded once in `loadAll()` alongside
`activities`/`contacts`), and new functions `renderLeadNextActions()`,
`addNextAction(event)`, `toggleNextActionDone(id, checked)`.

**Pipeline card 🔔 reminder.** `renderLeadCard` currently reads `l.next_action`/
`l.next_action_due` directly. It instead filters `nextActions` to this lead's
`completed_at === null` rows, picks the one with the earliest `due_date` (nulls-due-date
sorted last), and renders that — same red/amber overdue-vs-upcoming styling as today. No
open items for a lead → the 🔔 box is hidden, same as when `next_action` was null before.

## Testing

- New `supabase/tests/next_actions.test.sql`: RLS matrix (select all, insert own ok,
  insert as someone else rejected, owner completes their own item, admin edits any item,
  sales cannot edit another's item, delete root-only, cascade-delete when the parent lead
  is deleted) — same `pg_temp.as_user`/`pg_temp.expect` harness as every other test file.
- `pnpm check` / `pnpm build` in ric-crm.
- Live curl battery against the running dev server: create two next-actions on one lead
  with different due dates, confirm the Pipeline API/reminder logic picks the nearer one,
  mark it done, confirm the other becomes the picked one, delete as root, confirm 404
  afterward.

## Out of scope

- No due-date reminder notifications/emails — the 🔔 box is the only surface.
- No editing an existing item's text/date inline in this pass (mark-done and add-new
  only); editing is a cheap follow-up if it turns out to matter, deferred per YAGNI.
- No per-item assignee different from the lead's owner — `owner_id` defaults from
  `auth.uid()` on insert, same as every other new-row pattern in this app.
- Next-actions can only be added to a lead that already exists (has a real `lead_id`) —
  not while creating a new one in the same pass. A salesperson must save the lead first,
  then reopen it to add its first next-action.
