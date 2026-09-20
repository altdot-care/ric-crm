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

ทุก request รันในนามผู้ใช้ที่ล็อกอิน (JWT จาก cookie) จึงให้ **RLS ใน Postgres เป็นตัวตัดสินสิทธิ์** — ไม่มี service-role key ในแอป

## Development

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

> แอปอ่านเฉพาะ 2 ตัวแปรนี้ — `SUPABASE_SECRET_KEY` ใน `.dev.vars` (ถ้ามี) ใช้กับสคริปต์ของคุณเองเท่านั้น ห้ามตั้งเป็น Worker secret เพราะ key นี้ข้าม RLS

## ตั้งค่า Supabase (ครั้งแรก)

1. รัน migration `../supabase/migrations/20260920000000_init.sql` (โฟลเดอร์ `supabase/` อยู่นอก repo นี้ ที่ `~/Workspaces/supabase`) — วางใน **SQL Editor** ของ Supabase หรือรัน `pnpm dlx supabase db push` จากโฟลเดอร์นั้น
2. Authentication → Providers → Email: **ปิด "Allow new users to sign up"** (ทีมภายในเท่านั้น) แล้วเชิญผู้ใช้ผ่าน Authentication → Users → *Invite user* หรือ *Add user*
3. ผู้ใช้ใหม่ทุกคนได้ role `sales` อัตโนมัติ — เลื่อนเป็น admin ด้วย SQL:

   ```sql
   update public.profiles set role = 'admin' where id = '<user uuid>';
   ```

4. (เฉพาะ dev) ใส่ข้อมูลตัวอย่างด้วย `../supabase/seed.sql` — วางใน SQL Editor ต้องมีผู้ใช้อย่างน้อย 1 คนก่อน รันซ้ำได้ปลอดภัย **ห้ามรันบน production**

> ข้อมูลเดิมใน Cloudflare D1 **ไม่ได้ถูกย้ายให้อัตโนมัติ** (schema เปลี่ยน: id เป็น uuid, ผู้รับผิดชอบเป็น `owner_id`) ถ้ามีข้อมูลจริงให้ export แล้ว import แยกต่างหาก

## Deploy (Cloudflare Workers)

```bash
pnpm wrangler login
pnpm wrangler secret put SUPABASE_PUBLISHABLE_KEY
pnpm deploy                      # astro build && wrangler deploy
```

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

นอก repo: `~/Workspaces/supabase/` — `migrations/` (schema + RLS) และ `seed.sql` (ข้อมูลตัวอย่างสำหรับ dev)
