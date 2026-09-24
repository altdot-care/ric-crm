# Companies, contacts, deal log & next action

Status: approved in chat 2026-09-24 (all 4 sections), not yet implemented.

## Problem

The Pipeline is a flat `leads` table: one row is one company, one free-text
contact name, one `notes` field that gets overwritten on every edit, and no
record of when the stage changed or why. Feedback from using it:

- No history — editing overwrites; there's no trail of "1.1.69 contacted,
  note: X" → "2.2.69 quoted, note: Y".
- No visible "what to do next, and when" on a deal.
- Only one contact per company, with no way to record their role (QMR, QA
  Manager, owner, purchasing, …).
- A company can only ever have one deal, because company data lives inside
  the lead row itself.

Separately, the app already has an `activities` table (call/email/meeting/
note + a follow-up date) that covers most of "log" and "next action" —
except it's not actually linked to a lead. `activities.company` is free
text matched by name for display, not a foreign key, so nothing shows on a
Pipeline card and a stage change never gets recorded there.

## Requirements (from discussion)

1. A company can have many deals (many `leads` rows), not just one.
2. Contacts belong to the company and are shared across all of that
   company's deals (not duplicated per deal).
3. Dragging a card still changes stage immediately — no forced note. Every
   stage change is logged automatically regardless (trigger-based, so it
   can't be bypassed by a future route or admin SQL).
4. "What to do next, and when" is its own field on the deal (not derived
   from the log), shown prominently on the Pipeline card.
5. No real company/lead data exists yet in production — the schema change
   does not need a data migration, only fresh seed data.
6. The personal/address fields added earlier this week (gender, occupation,
   postcode, address1/2, sub_district, district, province, status) move
   from `leads` to `contacts` — they describe a person, not a deal.
7. The existing "กิจกรรม" nav tab stays as a read-only feed across all
   deals; each row links to that deal's card in Pipeline. Creating an entry
   only happens from within a deal (since it now requires a `lead_id`).

**Explicitly out of scope:** `renewals.company` stays free text — it is not
linked to `companies`. Not requested; can be a follow-up if wanted.

## Data model

### `companies` (new)
`id uuid pk, name text not null, created_at, owner_id` — same RLS pattern
as every other table in this app (`select` for all authenticated users,
`insert`/`update` by owner or admin, `delete` root only).

### `contacts` (new)
`id uuid pk, company_id uuid not null references companies, full_name text
not null, position text` (free text — no fixed enum, so a new job title
never needs a code change), `phone, email` (moved from `leads`), `gender,
occupation, postcode, address1, address2, sub_district, district, province,
status smallint not null default 1` (moved from `leads`, same types as
today), `owner_id, created_at`. Same RLS pattern as `companies`.

### `leads` (modified — table keeps its name; every route/RLS policy/test
already refers to it, and renaming buys nothing)
- **Drop:** `company, contact, phone, email, postcode, gender, occupation,
  address1, address2, sub_district, district, province, status` (moved to
  `contacts`, reached via `company_id`/`primary_contact_id`).
- **Add:** `company_id uuid not null references companies`,
  `primary_contact_id uuid null references contacts` (must belong to
  `company_id` — enforced in the API layer, since a cross-table check
  constraint can't easily reference another table's row in Postgres;
  document this instead of half-solving it with a trigger),
  `next_action text null`, `next_action_due date null`.
- **Unchanged:** `cert[], stage, value, notes, quote_link, owner_id,
  created_at, updated_at`. `notes` stays a free-form "current summary"
  field, distinct in purpose from the append-only log below — it's the
  one thing a salesperson can still overwrite at will (e.g. "waiting on
  their finance approval"), while the log is the permanent history.

### `activities` (modified — this is the deal log)
- **Add:** `lead_id uuid not null references leads on delete cascade`.
- **Add to the `type` check constraint:** `'stage_change'` alongside the
  existing `call/email/meeting/note`.
- **Drop:** `company` (free text) — the company name is now reached via
  `activities.lead_id → leads.company_id → companies.name`.
- **New trigger** `leads_log_stage_change` (AFTER UPDATE on `leads`, WHEN
  `stage` changed, `security definer` like the existing `handle_new_user`/
  `reassign_owner`): inserts an `activities` row
  `{lead_id, type: 'stage_change', description: '<old label> → <new
  label>', owner_id: auth.uid()}`. Fires no matter which route or tool
  changed the stage.

## RLS

`companies` and `contacts` reuse the exact select/insert/update/delete
policy shapes already defined for `leads`/`activities`/`renewals` — no new
SQL helper functions needed beyond the existing `is_admin()`/`is_root()`.
`activities` keeps its own `owner_id`-based policies unchanged; access to
an activity does not depend on access to its `lead_id` row.

## API

- New: `GET/POST /api/companies`, `PUT/DELETE /api/companies/[id]`.
- New: `GET/POST /api/contacts` (`GET` filtered by `?company_id=`),
  `PUT/DELETE /api/contacts/[id]`.
- Changed: `leadInput`/`leadCreate`/`leadUpdate` in `schemas.ts` drop the
  removed columns and add `company_id` (required), `primary_contact_id`,
  `next_action`, `next_action_due`. The API validates that
  `primary_contact_id`, if given, belongs to `company_id`.
- Changed: `activityCreate` requires `lead_id`; `GET /api/activities`
  joins `leads → companies` to return a company name for the feed.
  `stage_change` rows are never created through this route — the Zod
  `type` enum on `activityCreate` stays `call/email/meeting/note` only
  (unchanged from today). `stage_change` is added solely to the
  database's `type` check constraint, since only the trigger (running as
  `security definer`, bypassing the API) ever writes that value.

## UI

- New "บริษัท" nav item: searchable company list → company detail (add/
  edit/delete contacts; list of that company's deals, open/closed).
- Deal modal: `company` free-text input becomes a company picker (search
  existing + "+ เพิ่มบริษัทใหม่" inline). Once a company is picked,
  `primary_contact_id` becomes a dropdown of that company's contacts (+
  "เพิ่มผู้ติดต่อใหม่" inline). Gender/occupation/address fields move out
  of this modal into the contact's own add/edit form. New
  "งานถัดไป"/"วันครบกำหนด" fields added near Stage.
- Pipeline card: shows company name, primary contact + position, value,
  cert tags, and a highlighted "🔔 <next_action> — ครบกำหนด <date>" box
  when `next_action` is set.
- Clicking a card opens a deal detail panel with two tabs: "ข้อมูล" (the
  modal form above) and "Log" (chronological feed of that lead's
  `activities`, including auto `stage_change` rows, with a quick-add form
  for manual entries).
- "กิจกรรม" nav tab becomes a read-only, all-deals feed; each row links to
  that deal's card/panel in Pipeline. No create action lives on this tab
  anymore.

## Rollout (two phases, one plan)

**Phase 1 — companies & contacts.** Migration (`companies`, `contacts`,
drop/move columns on `leads`) → new API routes → "บริษัท" page → deal
modal switches to company/contact pickers.

**Phase 2 — log & next action.** Migration (`activities.lead_id`, `type`
constraint, `stage_change` trigger, `leads.next_action*`) → Pipeline card
next-action box → two-tab deal detail panel → "กิจกรรม" tab becomes a
linking feed.

Phase 2 depends on Phase 1 (needs `company_id` to join for the feed's
company name), so they run in this order, in one implementation plan.

## Risks / open items

- This is the largest schema change in the project so far — touches every
  file that reads/writes `leads` or `activities` (API routes, `schemas.ts`,
  Pipeline UI, RLS tests, seed data).
- `seed.sql` must be rewritten to create companies and contacts first, then
  leads that reference them.
- No production data to preserve (confirmed) — no data-migration script
  needed, just new seed data.
- `primary_contact_id` belonging to `company_id` is enforced in the API,
  not the database — worth a comment at the call site so it isn't
  "fixed" into a broken cross-table check constraint later.
