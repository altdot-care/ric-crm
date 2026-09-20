# Roles (root / admin / sales) and root-only user management

Status: approved in chat 2026-09-20, implemented.

## Requirements
- Three roles. `sales` and `admin` can do everything except delete; only `root` can delete and can do everything else.
- Root creates users with a password from inside the app (also: list, change role, delete).
- Chosen in discussion: everyone reads the whole team's data; sales edit only their own rows; admin edit any row;
  deleting a user hands their data to the root who deletes them; user creation uses the service-role key in the Worker.

## Design
1. **Database** (`supabase/migrations/20260920100000_roles_root.sql`): `profiles.role` in (root, admin, sales);
   `is_admin()` = admin or root, new `is_root()`; select policies `using (true)`; delete policies root-only;
   profile updates root-only plus trigger `guard_profile_role` (no granting/removing root, no self role change);
   `reassign_owner(from, to)` executable only by `service_role`.
2. **API** (`src/pages/api/users.ts`, `users/[id].ts`): every handler calls `requireRoot()` (role read from the DB
   as the caller). `createAdminClient()` (service-role) is confined to these routes. Roles accepted from the client:
   admin | sales only. DELETE of leads/renewals also returns 403 to non-root (RLS would otherwise surface as 404).
3. **UI** (`src/pages/index.astro`): "ผู้ใช้" page for root; delete buttons hidden for non-root; rows a sales user
   does not own open read-only and cannot be dragged. UI hiding is convenience only — RLS is the enforcement.

## Trade-offs
- The service-role key in the Worker bypasses RLS; a bug in `/api/users/*` is more dangerous than elsewhere. Mitigated by
  confining the client to one module and requiring root on every route.
- Root cannot be created/removed from the app by design; use SQL.

## Verification
- `supabase/tests/roles.test.sql` (18 RLS checks, rolled back) and an end-to-end curl run against `wrangler dev`
  covering each role, user creation, role change, and delete-with-reassign.
