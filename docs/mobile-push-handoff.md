# Mobile / PWA / push notifications

งานต่อจากแผน `docs/superpowers/plans/2026-09-25-push-notifications.md`

## สิ่งที่ทำ

- ปุ่มเปิด/ปิดแจ้งเตือนในเมนู แสดงสถานะและคำแนะนำติดตั้งบน iPhone/iPad แบบอ่านได้ด้วยการแตะ
- สมัครอุปกรณ์ผ่าน API ที่ใช้ session และ RLS ของเจ้าของเท่านั้น สมัครซ้ำไม่เพิ่มแถวซ้ำ
- ยกเลิกการสมัครเก่าเมื่อเปลี่ยนบัญชี และปิดการรับแจ้งเตือนเมื่อออกจากระบบ
- Service worker แสดง push และเปิดหน้าแอปเมื่อแตะ โดยจำกัด URL ให้อยู่ในเว็บเดียวกัน
- Worker แยก ส่งเวลา **08:00 น. ประเทศไทย** ทุกวัน: งานครบกำหนด/เลยกำหนด, ใบรับรองใกล้วันตรวจ/วันหมดอายุภายใน 30 วัน และเมื่อเลยกำหนด
- บันทึก milestone ก่อนส่งเพื่อป้องกันการส่งซ้ำ แม้ Cron รันพร้อมกัน; ลบ subscription ที่ปลายทางตอบ 404/410
- เก็บงาน mobile เพิ่ม: ช่องค้นหาบริษัทเต็มแถวบนจอเล็ก, การ์ดใบรับรองเรียงแนวตั้ง, เมนูเลื่อนได้ในแนวนอน, Escape/Tab/focus และช่องกรอก 16px

## การตัดสินใจที่ต่างจากแผนเดิม

- เก็บ migration ที่ Claude สร้างและ apply ใน local ไว้แล้ว ไม่ reset ฐานข้อมูล
- ตาราง subscription ไม่มี UPDATE policy ตามสเปก จึงใช้ select/insert แบบ idempotent และ delete/recreate เมื่อ key เปลี่ยน แทน upsert ที่จะถูก RLS ปฏิเสธ
- อ่าน VAPID public key ตอน runtime ผ่าน `/api/me`; private key อยู่เฉพาะ Cron Worker
- ใช้ endpoint allowlist ของ Chrome/Firefox/Apple/Windows และห้าม redirect เพื่อป้องกัน request ไปปลายทางอื่น Provider ใหม่ต้องเพิ่ม allowlist ทั้ง API และ sender
- ตรวจ subscription ก่อน claim milestone เพื่อไม่ตัดโอกาสแจ้งเตือนของผู้ที่ยังไม่ได้เปิดใช้งาน
- ใช้ `web-push` สร้าง payload ที่เข้ารหัสและ VAPID จากนั้นส่งด้วย native `fetch` พร้อม timeout
- ใช้ pnpm workspace และ lockfile เดียว แต่แยก deploy Worker ชัดเจน ทุกคำสั่ง Cron ระบุ `--config wrangler.toml` เพื่อไม่เลือก config ที่ Astro สร้างให้เว็บหลัก
- ทดสอบด้วยบัญชี/รายการชั่วคราวและ transport ที่ดักไว้ ไม่ส่ง push ไปยังผู้ใช้จริงระหว่างทดสอบ

## ตั้งค่าและทดสอบในเครื่อง

ผลตรวจในรอบนี้: app unit tests 9/9, Cron tests 3/3, browser/API tests 8/8,
SQL suites 5/5 ผ่าน; `pnpm check` ได้ 0 errors, 0 warnings (32 hints),
เว็บ build และ Cron type-check/dry-run ผ่าน ตรวจ Workers runtime ได้
`{"status":201,"encrypted":true,"signed":true}` โดยไม่ส่ง push จริง

ต้องมี Supabase local รันอยู่ และ `.dev.vars` ของเว็บตั้ง URL/key ของ local เท่านั้น

```sh
pnpm install
# ครั้งแรกเท่านั้น สร้าง VAPID key ในไฟล์ .dev.vars ที่ gitignore ไว้ ไม่พิมพ์ private key
node cron-notifications/scripts/setup-local.mjs
pnpm dev
pnpm test
pnpm test:mobile
pnpm --dir cron-notifications run test
pnpm --dir cron-notifications run check
pnpm --dir cron-notifications run build  # dry-run เท่านั้น
pnpm check
pnpm build
```

`test:mobile` ใช้ Google Chrome ที่ติดตั้งไว้และ dev server `localhost:4321` ที่เปิดอยู่
ทั้ง browser และ Cron integration tests ตรวจว่า Supabase URL เป็น localhost ก่อนสร้าง fixture

ทดสอบ RLS จาก sibling repo `../supabase`:

```sh
docker exec -i supabase_db_Workspaces psql -U postgres -v ON_ERROR_STOP=1 < tests/notifications.test.sql
```

ทดสอบการเข้ารหัสใน Workers runtime จริงแบบ local (ไม่ส่ง request ออกไปยัง push service):

```sh
cd cron-notifications
pnpm exec wrangler dev --config wrangler.runtime.toml --port 8799 --ip 127.0.0.1
# อีก terminal:
curl --fail http://127.0.0.1:8799/
# {"status":201,"encrypted":true,"signed":true}
```

ห้าม deploy `wrangler.runtime.toml` เพราะเป็น test harness เท่านั้น

## Deploy — ต้องยืนยันก่อน

Task 10 ของแผนเดิมกำหนดให้ยืนยันก่อนสร้าง production Worker, Cron Trigger และ secrets
ยังไม่ได้ deploy หรือส่งแจ้งเตือนจริงจากงานรอบนี้

1. ตรวจ production Supabase project ให้ถูกต้อง และ apply migration สองไฟล์ใน `../supabase/migrations/`:
   `20260926050000_push_subscriptions.sql` และ `20260926060000_notification_log.sql`
2. สร้าง VAPID keypair สำหรับ production เก็บ private key ใน secret manager อย่า commit และอย่าเปลี่ยน keypair หลังมีผู้สมัครโดยไม่วางแผนสมัครใหม่
3. ตั้ง `VAPID_PUBLIC_KEY` ให้เว็บหลัก จากนั้น `pnpm deploy`
4. ตั้ง secrets ให้ Worker `ric-crm-notifications-cron`: `SUPABASE_URL`, `SUPABASE_SECRET_KEY` ของ production, `VAPID_PUBLIC_KEY` ที่ตรงกับเว็บ และ `VAPID_PRIVATE_KEY`
5. ตรวจ `VAPID_SUBJECT` ให้เป็นอีเมลผู้ดูแลที่ใช้งานจริง (ค่าเริ่มต้น `mailto:support@ricroyal.co.th`)
6. จาก `cron-notifications/` ใช้ `pnpm exec wrangler secret put <NAME> --config wrangler.toml` และ `pnpm run deploy`
7. ตรวจ Cron Trigger `0 1 * * *` และจำนวน `sent/skipped/failed/pruned` ใน Worker logs

## ตรวจบนเครื่องจริงหลัง deploy

- Android Chrome: เปิดเว็บ HTTPS → เปิดแจ้งเตือน → อนุญาต → ตรวจรายการของตนเองที่ครบกำหนดว่ามี push เข้ามา
- iPhone/iPad: Safari → แชร์ → เพิ่มไปยังหน้าจอโฮม → เปิดจากไอคอน → เปิดแจ้งเตือน ต้องรองรับ Home Screen Web Push
- แตะ push แล้วเข้า CRM; ปิดแจ้งเตือน/ออกจากระบบแล้วไม่รับของบัญชีเดิมอีก
- รัน Cron ซ้ำสำหรับ milestone เดิมแล้วไม่ส่งซ้ำ

ข้อกำหนดการติดตั้งและการขอสิทธิ์จากการแตะอ้างอิง [WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

## ข้อจำกัดตามสเปก

- รับประกันการพยายามส่งไม่เกินหนึ่งครั้งต่อ `(kind, entity_id)` ไม่ใช่รับประกันว่าถึงอุปกรณ์ ระบบไม่ retry หลังเริ่มส่งแล้วล้มเหลว
- เมื่อส่ง milestone แล้ว การเลื่อนวัน/เปลี่ยนเจ้าของของแถวเดิมไม่ reset log; รอบใบรับรองใหม่ควรใช้แถวใหม่
- ไม่มี inbox, ตัวเลือกแยกประเภท หรือ deep link ไปแต่ละรายการ; แตะแล้วเปิด dashboard
- การทดสอบอัตโนมัติยืนยัน UI/API/RLS/การเลือก milestone/ป้องกันส่งซ้ำ/การเข้ารหัสใน runtime แต่การรับ push จริงบน Android/iOS ต้องตรวจหลัง deploy
