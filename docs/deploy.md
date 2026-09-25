# คู่มือ Deploy ขึ้น Production

ระบบมี 3 ส่วนที่ต้อง deploy และ **ต้องทำตามลำดับนี้**:

| # | ส่วน | ที่อยู่ | ทำอะไร |
|---|---|---|---|
| 1 | ฐานข้อมูล | Supabase production (repo `supabase`) | schema, RLS, trigger |
| 2 | Cron Worker | Cloudflare Worker `ric-crm-notifications-cron` (โฟลเดอร์ `cron-notifications/`) | ส่งแจ้งเตือนทุก 5 นาที และรับคำสั่งทดสอบจากหน้า `/preview` |
| 3 | เว็บหลัก | Cloudflare Worker `ric-crm` (โฟลเดอร์นี้) | หน้าเว็บ + API |

**ทำไมต้องเรียงแบบนี้:** เว็บและ Cron เขียน/อ่านคอลัมน์ใหม่ (เช่น `activities.followup_time`) ถ้า deploy หรือ push `main` ก่อน migration ครบ การบันทึก Log จะตอบ 500 และ Cron จะล้มทุกรอบ (รวมถึง build ของ Cloudflare ที่ต่อกับ git ซึ่ง deploy เองเมื่อ push)

> ห้ามใส่ค่า secret, รหัสผ่าน หรือ private key ในไฟล์ที่ commit หรือในแชท ค่าทั้งหมดในเอกสารนี้เป็นชื่อตัวแปรเท่านั้น

## ตัวแปรและ secret ทั้งหมด (ใครต้องมีอะไร)

| ชื่อ | เว็บหลัก `ric-crm` | Cron Worker | ค่าคืออะไร |
|---|:---:|:---:|---|
| `SUPABASE_URL` | ✅ (plain var ใน `wrangler.jsonc`) | ✅ secret | URL ของ Supabase project **production** |
| `SUPABASE_PUBLISHABLE_KEY` | ✅ secret | – | publishable key (`sb_publishable_…`) |
| `SUPABASE_SECRET_KEY` | ✅ secret (ใช้เฉพาะหน้า "ผู้ใช้" ของ root) | ✅ secret | secret key (`sb_secret_…`) ข้าม RLS ได้ทั้งหมด |
| `VAPID_PUBLIC_KEY` | ✅ secret | ✅ secret | public key ของ VAPID **ต้องเป็นค่าเดียวกันทั้งสองฝั่ง** |
| `VAPID_PRIVATE_KEY` | ❌ **ห้ามใส่** | ✅ secret | private key ของ VAPID อยู่ที่ Worker เท่านั้น |
| `VAPID_SUBJECT` | – | ✅ secret | `mailto:อีเมลผู้ดูแลจริง` |
| `NOTIFIER_SECRET` | ✅ secret (ไม่บังคับ) | ✅ secret | รหัสลับร่วมของหน้า `/preview` ยาว ≥ 32 ตัวอักษร ค่าเดียวกันทั้งสองฝั่ง |
| `NOTIFIER_URL` | ✅ (ไม่บังคับ) | – | URL ของ Cron Worker เช่น `https://ric-crm-notifications-cron.<subdomain>.workers.dev` (แค่ scheme + host) |

---

## ขั้นที่ 1: ฐานข้อมูล (Supabase)

`../supabase/migrations/` มีไฟล์เดียว `20260920000000_init.sql` เป็น schema สุดท้ายทั้งหมด (รวมตาราง `push_subscriptions`, `notification_log` และคอลัมน์ `followup_time`) ยังไม่มีไฟล์ migration อื่น

### วิธี A: `supabase db push` (แนะนำ)
```sh
cd ~/Workspaces/supabase
supabase link --project-ref <project-ref ของ production>
supabase db push --dry-run     # ดูสิ่งที่จะรันก่อน
supabase db push
```

### วิธี B: วางใน SQL Editor ของ Supabase
เปิด query ใหม่ วาง `init.sql` **ทั้งไฟล์** แล้วรันครั้งเดียว ห้ามรันทีละท่อน

> ⚠️ SQL Editor **ไม่ย้อนกลับทั้งไฟล์** เมื่อ error กลางทาง ของที่สร้างไปแล้วจะค้างอยู่ และการรันซ้ำจะชนด้วย error แบบ
> `42723: function "handle_new_user" already exists with same argument types`

### ถ้ารัน `init.sql` แล้วพังกลางทาง (หรือมีของค้างอยู่ก่อน)
ให้รัน preflight นี้ก่อน แล้วรัน `init.sql` ซ้ำทั้งไฟล์ ทุกครั้งที่พัง ให้รัน preflight ใหม่ก่อนลองอีกรอบ
preflight **หยุดโดยไม่ลบอะไรเลย** ถ้าตารางไหนของเรามี**ข้อมูล**อยู่ และไม่ใช้ `cascade` (ถ้ามีอย่างอื่นพึ่งพา มันจะ error แทนที่จะลบเงียบๆ)

```sql
do $$
declare
  t text; n bigint; with_data text := '';
begin
  foreach t in array array['profiles','companies','contacts','leads','activities',
                           'renewals','push_subscriptions','notification_log'] loop
    if to_regclass('public.' || t) is not null then
      execute format('select count(*) from public.%I', t) into n;
      if n > 0 then with_data := with_data || t || ' (' || n || ' rows) '; end if;
    end if;
  end loop;
  if with_data <> '' then
    raise exception 'STOP - these tables already contain data: %. Do NOT run init.sql; send the diagnostic output instead.', with_data;
  end if;
end
$$;

drop trigger  if exists on_auth_user_created on auth.users;
drop table    if exists public.notification_log;
drop table    if exists public.push_subscriptions;
drop table    if exists public.renewals;
drop table    if exists public.activities;
drop table    if exists public.leads;
drop table    if exists public.contacts;
drop table    if exists public.companies;
drop table    if exists public.profiles;
drop function if exists public.handle_new_user();
drop function if exists public.is_admin();
drop function if exists public.is_root();
drop function if exists public.guard_profile_role();
drop function if exists public.set_updated_at();
drop function if exists public.log_stage_change();
drop function if exists public.reassign_owner(uuid, uuid);
```

**ถ้าขึ้น `STOP ... already contain data`:** หยุด อย่ารัน `init.sql` แปลว่า production เคยมี schema ของเราแล้ว ต้องทำ migration แบบอัปเกรดที่ไม่ทับข้อมูล ห้ามเพิ่ม `create or replace` หรือ `cascade` เองเพื่อให้ผ่าน

ดูว่า production มีอะไรอยู่ (อ่านอย่างเดียว):
```sql
select 'table' as kind, tablename::text as name, null::text as detail
from pg_tables where schemaname = 'public'
union all
select 'function', p.proname::text, pg_get_function_identity_arguments(p.oid)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
union all
select 'auth.users trigger', t.tgname::text, pg_get_triggerdef(t.oid)
from pg_trigger t where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal
union all
select 'auth.users rows', count(*)::text, null from auth.users
order by 1, 2;
```

### หลัง `init.sql` ผ่าน
1. **ตรวจ:** ต้องมี 8 ตาราง (`profiles`, `companies`, `contacts`, `leads`, `activities`, `renewals`, `push_subscriptions`, `notification_log`) และไม่มีป้าย UNRESTRICTED (RLS เปิดครบ)
2. **ผู้ใช้ที่มีอยู่แล้วใน `auth.users`** ต้องมี profile (trigger สร้างให้เฉพาะผู้ใช้ใหม่ ไม่งั้นแอปตอบ 403 กับบัญชีนั้น) แล้วตั้งบัญชีของคุณเป็น root:
   ```sql
   insert into public.profiles (id, full_name)
   select id, coalesce(raw_user_meta_data ->> 'full_name', split_part(email, '@', 1))
   from auth.users on conflict (id) do nothing;

   update public.profiles set role = 'root'
   where id = (select id from auth.users where email = '<อีเมลของคุณ>');
   ```
3. ถ้าใช้วิธี B (SQL Editor) แล้วภายหลังจะใช้ `supabase db push` ให้บันทึกว่าไฟล์นี้ apply แล้ว ไม่งั้น `db push` จะพยายามรันซ้ำแล้วชน:
   `supabase migration repair --status applied 20260920000000 --linked`
4. **ห้ามรัน `seeds/user-init.sql` และ `seed.sql` บน production** (ของ dev มีรหัสผ่านตัวอย่าง)

### กฎเมื่อแก้ schema ต่อจากนี้
เมื่อ `init.sql` ถูก apply ลง production แล้ว **ห้ามแก้เนื้อหาไฟล์เดิม** ให้เพิ่มไฟล์ migration ใหม่ (ชื่อขึ้นต้นด้วยเวลาที่ใหม่กว่า) เพราะ `db push` จำ migration ตามเลขเวอร์ชันและจะไม่รันไฟล์เดิมซ้ำ

---

## ขั้นที่ 2: Cron Worker (`cron-notifications/`)

### เตรียมของที่ต้องใช้ (ทำครั้งเดียว)
```sh
cd ~/Workspaces/ric-crm/cron-notifications

# VAPID key คู่สำหรับ production (ห้ามใช้ชุดเดียวกับที่ใช้ในเครื่อง dev)
pnpm exec web-push generate-vapid-keys

# รหัสลับร่วมของหน้า /preview (สุ่ม 64 ตัวอักษร)
openssl rand -hex 32
```
เก็บ Private key และ `NOTIFIER_SECRET` ไว้ใน password manager **อย่าเปลี่ยน VAPID key หลังมีคนสมัครแจ้งเตือนแล้ว** ทุกคนจะต้องสมัครใหม่

### ตั้ง secret แล้ว deploy
```sh
pnpm exec wrangler login       # ครั้งแรก ใช้บัญชี Cloudflare เดียวกับที่ deploy เว็บ

pnpm exec wrangler secret put SUPABASE_URL        --config wrangler.toml   # URL ของ production project
pnpm exec wrangler secret put SUPABASE_SECRET_KEY --config wrangler.toml   # sb_secret_… ของ production
pnpm exec wrangler secret put VAPID_PUBLIC_KEY    --config wrangler.toml
pnpm exec wrangler secret put VAPID_PRIVATE_KEY   --config wrangler.toml
pnpm exec wrangler secret put VAPID_SUBJECT       --config wrangler.toml   # mailto:อีเมลผู้ดูแลจริง
pnpm exec wrangler secret put NOTIFIER_SECRET     --config wrangler.toml
pnpm run deploy
```
- แต่ละคำสั่ง `secret put` จะให้วางค่า (ไม่แสดงบนจอ) ถ้า Worker ยังไม่มี wrangler จะถามว่าจะสร้างไหม ตอบใช่
- **ทุกคำสั่งต้องมี `--config wrangler.toml`** เพื่อไม่ให้ wrangler ไปเลือกคอนฟิกของเว็บหลัก (`pnpm run deploy` ใส่ให้อยู่แล้ว)
- `deploy` ลงทะเบียน Cron Trigger `*/5 * * * *` (ทุก 5 นาที) จาก `wrangler.toml` ให้เอง และพิมพ์ URL ของ Worker (`https://ric-crm-notifications-cron.<subdomain>.workers.dev`) จดไว้ใช้กับ `NOTIFIER_URL`
- ตรวจ build ก่อนได้โดยไม่ส่งอะไรขึ้น Cloudflare: `pnpm run build` (dry-run)

### พฤติกรรมของ cron (เพื่อให้ตรวจถูก)
- นัดติดตามในแท็บ Log ที่มีเวลา → ส่งเมื่อถึงเวลานั้น (คลาดไม่เกิน 5 นาที); ที่ไม่มีเวลาและใบรับรองใกล้วันตรวจ/หมดอายุใน 30 วัน (รวมเมื่อเลยกำหนด) → ส่งตั้งแต่ 08:00 น. เวลาไทย
- นัดติดตามแจ้งเฉพาะ**ในวันที่นัด** ไม่มีแจ้ง "เลยกำหนด"; นัดเวลา 23:56–23:59 ส่งตอน 23:55
- ระบบกันส่งซ้ำด้วยตาราง `notification_log` (หนึ่งครั้งต่อรายการ) ถ้าเลื่อนวัน/เวลาของนัดที่แจ้งไปแล้ว จะไม่แจ้งซ้ำ

---

## ขั้นที่ 3: เว็บหลัก (`ric-crm`)

```sh
cd ~/Workspaces/ric-crm
pnpm wrangler login
pnpm wrangler secret put SUPABASE_PUBLISHABLE_KEY
pnpm wrangler secret put SUPABASE_SECRET_KEY      # ใช้เฉพาะหน้า "ผู้ใช้" ของ root
pnpm wrangler secret put VAPID_PUBLIC_KEY         # ค่าเดียวกับที่ตั้งให้ Cron Worker (ต้องตรงกันเป๊ะ)
pnpm deploy                                       # astro build && wrangler deploy
```
- `SUPABASE_URL` เป็น plain variable ใน `wrangler.jsonc` (`"vars"`) ตรวจว่าเป็น URL ของ **production**
- ถ้าเชื่อม GitHub กับ Workers Builds: build command `pnpm build`, deploy command `pnpm wrangler deploy` (push `main` จะ deploy เอง จึงต้องทำขั้นที่ 1 ให้เสร็จก่อน push)
- ถ้าไม่ตั้ง `VAPID_PUBLIC_KEY` ปุ่ม 🔔 ในเว็บจะไม่ทำงาน

### เปิดหน้า `/preview` บน production (ไม่บังคับ)
```sh
pnpm wrangler secret put NOTIFIER_SECRET   # ค่าเดียวกับที่ตั้งให้ Cron Worker
pnpm wrangler secret put NOTIFIER_URL      # https://ric-crm-notifications-cron.<subdomain>.workers.dev (ใส่แค่ scheme + host)
pnpm deploy                                # ให้ค่าใหม่มีผล
```
- ทางเรียก `/preview/*` ของ Cron Worker **ปิดอยู่ (ตอบ 503)** จนกว่าจะตั้ง `NOTIFIER_SECRET` ที่ Worker
- เว็บรองรับแค่ URL ธรรมดา (service binding ยังไม่รองรับ ต้องแก้โค้ดก่อน) และ path ใน `NOTIFIER_URL` จะถูกตัดทิ้ง
- ⚠️ ยังไม่เคยลองบน Cloudflare จริง: ถ้าตั้งค่าถูกแล้วแต่หน้า `/preview` ขึ้น "เชื่อมต่อ Cron Worker ไม่ได้" อาจเป็นข้อจำกัดของ Cloudflare ที่ไม่ให้ Worker เรียก Worker อีกตัวในบัญชีเดียวกันผ่าน `workers.dev` โดยตรง (error 1042) ทางแก้คือใช้ service binding ซึ่งต้องแก้โค้ด ไม่กระทบการแจ้งเตือนจริง (กระทบเฉพาะหน้า preview)

---

## ตรวจว่าทำงานจริงหลัง deploy

1. **Cron ทำงาน:** ดู log สด `cd cron-notifications && pnpm exec wrangler tail --config wrangler.toml` รอสูงสุด 5 นาทีจะเห็นบรรทัด `Notification run: {"sent":…,"skipped":…,"failed":…,"pruned":…}` ทุกรอบ
2. **สมัครอุปกรณ์:** บนมือถือเปิดเว็บ production ผ่าน **HTTPS** (iPhone/iPad ต้อง Safari → แชร์ → "เพิ่มไปยังหน้าจอโฮม" แล้วเปิดจากไอคอน) ล็อกอิน ติ๊ก 🔔 แจ้งเตือนที่เมนูซ้าย แล้วกดอนุญาต การสมัครที่ทำบน dev ใช้กับ production ไม่ได้
3. **ทดสอบส่ง:** ล็อกอินด้วย root เปิด `/preview` กด "ส่งแจ้งเตือนทดสอบ" หรือสร้างบันทึกใน Log ที่มี "นัดติดตาม" เป็นวันนี้ในอีก 5–10 นาทีข้างหน้า แล้วรอแจ้งเตือน
4. แตะแจ้งเตือนแล้วต้องเปิด CRM; ปิดแจ้งเตือน/ออกจากระบบแล้วต้องไม่ได้รับของบัญชีเดิมอีก

## ถอยกลับ / หยุดชั่วคราว
- ย้อนเวอร์ชัน Worker: `pnpm exec wrangler rollback --config wrangler.toml` (Cron) หรือ `pnpm wrangler rollback` (เว็บ)
- หยุดการส่งแจ้งเตือน: ลบบรรทัด `[triggers]` และ `crons` ใน `cron-notifications/wrangler.toml` แล้ว `pnpm run deploy`
- ฐานข้อมูล: ไม่มีการถอยกลับอัตโนมัติ ให้แก้ด้วย migration ไฟล์ใหม่

## แก้ปัญหาที่เจอบ่อย

| อาการ | สาเหตุที่น่าจะเป็น | ทำอย่างไร |
|---|---|---|
| `42723: function "handle_new_user" already exists` ตอนรัน `init.sql` | มีของค้างจากการรันครั้งก่อนหรือเทมเพลตเดิม | รัน preflight ในขั้นที่ 1 ก่อน แล้วรัน `init.sql` ทั้งไฟล์ใหม่ |
| preflight ขึ้น `STOP ... already contain data` | production มีข้อมูลอยู่แล้ว | หยุด อย่ารัน `init.sql` ทำ migration แบบอัปเกรดแทน |
| บันทึก Log ได้ 500 / cron ล้มทุกรอบ | migration `followup_time` ยังไม่ถูก apply | ทำขั้นที่ 1 ให้ครบก่อน deploy |
| บัญชีที่มีอยู่แล้วล็อกอินได้แต่แอปตอบ 403 | ไม่มีแถวใน `profiles` (ผู้ใช้เก่าก่อนมี trigger) | รัน backfill ในหัวข้อ "หลัง init.sql ผ่าน" |
| ปุ่ม 🔔 ไม่ทำงาน / push ไม่เข้า | เว็บไม่มี `VAPID_PUBLIC_KEY`, หรือไม่ตรงกับของ Cron Worker, หรือสมัครจากคนละ environment | ตั้งค่าให้ตรงกันแล้วให้ผู้ใช้สมัครใหม่บน production |
| `/preview/*` ของ Worker ตอบ 503 | ยังไม่ได้ตั้ง `NOTIFIER_SECRET` ที่ Worker หรือสั้นกว่า 32 ตัวอักษร | ตั้ง secret ที่ยาว ≥ 32 ตัวอักษรแล้ว deploy Worker ใหม่ |
| `/preview/*` ตอบ 401 | `NOTIFIER_SECRET` ของเว็บกับ Worker ไม่ตรงกัน | ตั้งให้เป็นค่าเดียวกัน |
| หน้า `/preview` ขึ้น "ยังไม่ได้ตั้งค่า NOTIFIER_URL / NOTIFIER_SECRET" | เว็บยังไม่มีตัวแปรทั้งสอง หรือยังไม่ได้ deploy ใหม่หลังตั้ง | ตั้งค่าตามหัวข้อ `/preview` แล้ว `pnpm deploy` |
| หน้า `/preview` ขึ้น "เชื่อมต่อ Cron Worker ไม่ได้" | `NOTIFIER_URL` ผิด, Worker ยังไม่ deploy, หรือข้อจำกัด error 1042 | ตรวจ URL และ log ของ Worker ถ้ายังไม่หายต้องใช้ service binding |
| Worker แจ้ง `failed` ทุกรอบ | key ไม่ตรงกัน (VAPID) หรือ endpoint ของอุปกรณ์หมดอายุ | ตรวจ VAPID key ทั้งสองฝั่ง; อุปกรณ์ที่หมดอายุ (404/410) ระบบลบเองใน `pruned` |

## ข้อควรรู้
- **แผน Cloudflare ฟรี** จำกัด 50 subrequest ต่อการรันหนึ่งครั้ง รอบ 08:00 ที่มีรายการใหม่หลายสิบรายการพร้อมกันอาจชนเพดาน (รายการที่ส่งไม่ทันจะไปต่อรอบถัดไป) แผนจ่ายเงินหลีกเลี่ยงได้ ควรตรวจแผนของบัญชี
- Cron Worker เปิด `fetch` handler ไว้ที่ `workers.dev` คนที่ไม่มี `NOTIFIER_SECRET` ได้แค่ 401/404/503 แต่ทุกครั้งที่ถูกเรียกนับเป็นการเรียก Worker
- Cloudflare Workers ไม่รองรับ `fetch(..., { redirect: 'error' })` ทุกการเรียกออกจึงใช้ `redirect: 'manual'` และนับ 3xx เป็นล้มเหลว (มี test กันไว้: `tests/no-unsupported-fetch-options.test.mjs`)
- รายละเอียดการตั้งค่าและทดสอบในเครื่อง: [mobile-push-handoff.md](mobile-push-handoff.md)
