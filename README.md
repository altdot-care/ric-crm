# RIC Sales CRM

ระบบ CRM สำหรับ Royal International Certification Co., Ltd.

## ฟีเจอร์

- 🎯 **Pipeline Kanban** — ลาก-วางลีดระหว่าง stage (ลีดใหม่ → ปิดดีล)
- 🔔 **แจ้งเตือนต่ออายุใบรับรอง** — ไฮไลต์ใบรับรองที่กำลังหมดอายุ
- 📋 **บันทึกกิจกรรม** — log โทรศัพท์ / อีเมล / ประชุม / บันทึก
- 📊 **ภาพรวม Dashboard** — KPI และลีดล่าสุด
- 🔐 **ล็อกอิน + สิทธิ์** — `admin` เห็นทุกอย่าง, `sales` เห็นเฉพาะข้อมูลที่ตัวเองเป็นเจ้าของ

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Astro 7 (SSR) |
| Styling | Tailwind CSS 4 (`@tailwindcss/vite`) |
| Hosting | Cloudflare Workers (+ static assets) via `@astrojs/cloudflare` |
| Database + Auth | Supabase (Postgres, Row Level Security, Supabase Auth) |
| Package manager | pnpm |

ทุก request รันในนามผู้ใช้ที่ล็อกอิน (JWT จาก cookie) จึงให้ **RLS ใน Postgres เป็นตัวตัดสินสิทธิ์**
ข้อยกเว้นเดียวคือ route จัดการผู้ใช้ `/api/users/*` (เฉพาะ root) ซึ่งต้องใช้ service-role key เพื่อสร้าง/ลบบัญชี — key นี้ถูกใช้ที่เดียวใน [src/lib/supabase-admin.ts](src/lib/supabase-admin.ts) และทุก route ตรวจว่าผู้เรียกเป็น root จากฐานข้อมูลก่อนเสมอ

## สิทธิ์ผู้ใช้

| Role | อ่าน | สร้าง | แก้ไข | ลบ | จัดการผู้ใช้ |
|---|---|---|---|---|---|
| `sales` | ทุกแถวของทีม | ของตัวเอง | เฉพาะของตัวเอง | ✗ | ✗ |
| `admin` | ทุกแถว | ให้ใครก็ได้ | ทุกแถว (โอนเจ้าของได้) | ✗ | ✗ |
| `root` | ทุกแถว | ให้ใครก็ได้ | ทุกแถว | ✓ | ✓ สร้างผู้ใช้+รหัสผ่าน เปลี่ยน role ลบผู้ใช้ |

- root **สร้างจากหน้าเว็บไม่ได้** และเปลี่ยน role ของ root / ของตัวเองไม่ได้ — ตั้งด้วย SQL เท่านั้น
- ลบผู้ใช้: lead/กิจกรรม/ใบรับรองของเขาจะโอนให้ root ที่กดลบ
- หน้า /preview (root เท่านั้น): ปุ่มทดสอบระบบแจ้งเตือน — ดู docs/mobile-push-handoff.md
- ทั้งหมดบังคับด้วย RLS ใน [supabase/migrations/20260920000000_init.sql](../supabase/migrations/20260920000000_init.sql) ทดสอบด้วย `supabase/tests/roles.test.sql`

## Development

งาน mobile/PWA และ push notifications: ดู [การตั้งค่า ทดสอบ และ deploy](docs/mobile-push-handoff.md)

ต้องใช้ Node ≥ 22.12 และ pnpm (`packageManager` ระบุเวอร์ชันไว้ใน `package.json`)

```bash
pnpm install
cp .dev.vars.example .dev.vars   # แล้วใส่ค่าจริง (ไฟล์นี้ถูก gitignore)
pnpm dev                         # http://localhost:4321
pnpm check                       # type-check
```

| ตัวแปร | ที่มา |
|---|---|
| `SUPABASE_URL` | Supabase → Project Settings → API |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase → Project Settings → API Keys (`sb_publishable_…`) |
| `SUPABASE_SECRET_KEY` | Supabase → Project Settings → API Keys (`sb_secret_…`) — ใช้เฉพาะหน้า "ผู้ใช้" ของ root ถ้าไม่ตั้ง หน้านั้นจะตอบ 503 |

> `SUPABASE_SECRET_KEY` **ข้าม RLS ทั้งหมด** — ตั้งเป็น Worker secret เท่านั้น (`pnpm wrangler secret put SUPABASE_SECRET_KEY`) ห้ามใส่ใน `wrangler.jsonc` หรือ commit

## ตั้งค่า Supabase (ครั้งแรก)

1. รัน migration ทุกไฟล์ใน `../supabase/migrations/` ตามลำดับชื่อไฟล์ (โฟลเดอร์ `supabase/` อยู่นอก repo นี้ ที่ `~/Workspaces/supabase`) — วางใน **SQL Editor** ของ Supabase หรือรัน `pnpm dlx supabase db push` จากโฟลเดอร์นั้น
2. Authentication → Providers → Email: **ปิด "Allow new users to sign up"** (ทีมภายในเท่านั้น) — ผู้ใช้ทั้งหมดสร้างโดย root ในหน้า "ผู้ใช้" ของแอป (บัญชี root แรกให้สร้างที่ Authentication → Users → *Add user* แล้วตั้ง role ตามข้อ 3)
3. ผู้ใช้ที่สร้างนอกแอปได้ role `sales` อัตโนมัติ — ตั้งบัญชี root แรกด้วย SQL:

   ```sql
   update public.profiles set role = 'root' where id = '<user uuid>';
   ```

4. (เฉพาะ dev) `supabase db reset` จะรัน `../supabase/seeds/user-init.sql` (สร้างผู้ใช้ root ของ dev) แล้วตามด้วย `../supabase/seed.sql` (ข้อมูลตัวอย่าง) ตามลำดับใน `config.toml` หรือวางสองไฟล์นี้ตามลำดับใน SQL Editor รันซ้ำได้ปลอดภัย **ห้ามรันบน production**

> ข้อมูลเดิมใน Cloudflare D1 **ไม่ได้ถูกย้ายให้อัตโนมัติ** (schema เปลี่ยน: id เป็น uuid, ผู้รับผิดชอบเป็น `owner_id`) ถ้ามีข้อมูลจริงให้ export แล้ว import แยกต่างหาก

## Deploy (Cloudflare Workers)

> คู่มือฉบับเต็มที่เรียงลำดับ Supabase → Cron Worker → เว็บ (รวม secret ทั้งหมดและวิธีแก้ปัญหา): [docs/deploy.md](docs/deploy.md)

```bash
pnpm wrangler login
pnpm wrangler secret put SUPABASE_PUBLISHABLE_KEY
pnpm deploy                      # astro build && wrangler deploy
```

- รัน migration ของ repo `supabase` ให้ครบก่อน deploy แอปนี้เสมอ — ถ้า migration ที่แอปนี้ต้องใช้ยังไม่ถึง การโหลดข้อมูลเริ่มต้นของ dashboard จะล้มเหลวทั้งหน้า ไม่ใช่แค่ส่วนที่เกี่ยวข้อง (`loadAll()` ยิง request หลายตัวพร้อมกันด้วย `Promise.all` — ตัวไหนพังก็ล้มทั้งก้อน)
- ตั้ง `SUPABASE_URL` เป็น plain variable ใน Cloudflare dashboard (Workers → ric-crm → Settings → Variables) หรือเพิ่ม `"vars": { "SUPABASE_URL": "https://<ref>.supabase.co" }` ใน `wrangler.jsonc`
- ครั้งแรก wrangler จะสร้าง KV namespace `SESSION` ให้อัตโนมัติ (adapter เปิดไว้เป็นค่าเริ่มต้น แอปนี้ยังไม่ได้ใช้)
- เชื่อม GitHub กับ Workers Builds ได้: build command `pnpm build`, deploy command `pnpm wrangler deploy` (Cloudflare ตรวจจับ pnpm จาก `packageManager` + `pnpm-lock.yaml`)

## โครงสร้าง

```
src/
  middleware.ts          # สร้าง Supabase client ต่อ request, บังคับล็อกอิน, security headers
  lib/                   # supabase client, response helpers, zod schemas
  layouts/Layout.astro
  pages/
    index.astro          # แอปหลัก (dashboard / pipeline / renewals / activities)
    login.astro
    api/                 # leads, activities, renewals, me, auth/{login,logout}
wrangler.jsonc           # Cloudflare Workers config
```

นอก repo: `~/Workspaces/supabase/` — `migrations/` (schema + RLS), `seeds/user-init.sql` (ผู้ใช้ root สำหรับ dev) และ `seed.sql` (ข้อมูลตัวอย่างสำหรับ dev)
