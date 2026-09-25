# เวลานัดติดตาม + หน้า /preview สำหรับ root

**สถานะ:** รอผู้ใช้ตรวจสเปก
**วันที่:** 2026-09-25

## ปัญหา

1. "นัดติดตาม" ในแท็บ Log มีแต่วันที่ จึงแจ้งเตือนได้แค่ 08:00 ของวันนั้น ผู้ใช้อยากกำหนดเวลาเองได้
2. ทดสอบการแจ้งเตือนยากมาก ต้องตั้ง VAPID, สมัครอุปกรณ์, สร้างนัดของวันนี้ แล้วสั่ง cron ด้วย `curl`
   ไม่มีทางส่งแจ้งเตือนทดสอบทันที

## เป้าหมาย

- ใส่ **เวลา** (ไม่บังคับ) ให้นัดติดตามได้ และได้รับแจ้งเตือนตอนถึงเวลานั้น (คลาดไม่เกิน 5 นาที)
  ถ้าไม่ใส่เวลา ให้ส่งตอน 08:00 เวลาไทยเหมือนเดิม
- หน้า `/preview` ที่ **root เท่านั้น** มีปุ่มทดสอบระบบแจ้งเตือนผ่านโค้ดส่งจริงตัวเดียวกับ production
- ตั้งค่า `.dev.vars` (ไฟล์จริงในเครื่อง, ไฟล์ `.example`, สคริปต์ setup) ให้พร้อมใช้ทันที

## นอกขอบเขต

- Deploy ขึ้น production (Worker, secret, service binding) ยังไม่ทำ แต่สเปกนี้ไม่ขวางการ deploy
- แจ้งเตือนซ้ำเมื่อแก้เวลาของนัดที่แจ้งไปแล้ว (ดู "ข้อจำกัดที่รู้")
- แจ้งเตือน "เลยกำหนด" ของนัดติดตาม (บันทึกใน Log ไม่มีสถานะ "เสร็จแล้ว")
- ปุ่มทดสอบอื่นนอกจาก 3 ปุ่มด้านล่าง (เพิ่มภายหลังได้)

## ส่วนที่ 1: เวลานัดติดตาม

### DB (repo `supabase`)

Migration ใหม่ `20260926090000_activities_followup_time.sql`:

- `alter table public.activities add column followup_time time null;` เก็บเวลาแบบ **เวลาไทย** (wall-clock)
  ไม่มี timezone เพราะทั้งระบบใช้เวลาไทย และ `followup` ก็เป็น `date` ไทยอยู่แล้ว
- `check (followup_time is null or followup is not null)` ห้ามมีเวลาโดยไม่มีวัน
- RLS ไม่เปลี่ยน (คอลัมน์ใหม่ในตารางเดิม)
- SQL test ใหม่ `tests/activities_followup_time.test.sql`: เก็บเวลาได้, เป็น null ได้, เวลาโดยไม่มีวันถูกปฏิเสธ

### API

- `activityCreate` และ `activityUpdate` รับ `followup_time` เป็น `"HH:MM"` (00:00–23:59) หรือ `""` (ล้างค่า)
- ส่งเวลามาโดยไม่มี `followup` ใน body เดียวกัน → 400
- `followup: ""` (ล้างวัน) ต้องล้าง `followup_time` ด้วยเสมอ
- ค่า `""` แปลงเป็น `null` ก่อนเขียน DB เหมือนที่ทำกับ `followup`

### UI (แท็บ Log)

- เพิ่มช่องเวลา (`<input type="time">`) ข้างช่องวัน ทั้งตอนเพิ่มและตอนแก้ไข
- ช่องเวลาใช้ได้เมื่อมีวัน (ปิดเมื่อวันว่าง และล้างค่าเมื่อล้างวัน)
- แสดง "🔔 นัดติดตาม: 2026-09-30 14:30" เมื่อมีเวลา ไม่มีเวลาแสดงแค่วัน
- ตอนกดแก้ไข ฟอร์มเติมเวลาเดิมให้

### Cron Worker

- ตารางเวลา `0 1 * * *` → `*/5 * * * *`
- ทุกรายการแจ้งเตือนมี "เวลาที่เริ่มส่งได้" (นาทีของวันตามเวลาไทย):
  - นัดติดตามที่มีเวลา = เวลานั้น
  - นัดติดตามที่ไม่มีเวลา = 08:00
  - ใบรับรอง (ตรวจ/หมดอายุ) = 08:00 เสมอ
- `findCandidates` ส่งเฉพาะรายการที่ "เวลาปัจจุบันตามเวลาไทย ≥ เวลาที่เริ่มส่งได้" ของวันนั้น
- นัดติดตามยังส่งเฉพาะวันที่ตรงกับ "วันนี้" (ตามเดิม) ระบบกันส่งซ้ำด้วย `notification_log` (kind + entity_id) ใช้ต่อได้
  ถ้าตัว cron พลาดรอบใด รอบถัดไปของวันเดียวกันจะส่งให้
- ข้อความแจ้งเตือนของนัดที่มีเวลาใส่เวลาไว้ด้วย เช่น "ถึงเวลานัดติดตาม 14:30"

### ข้อจำกัดที่รู้

- ถ้าแก้ "เวลา" ของนัดที่แจ้งเตือนไปแล้วในวันเดียวกัน จะไม่แจ้งซ้ำ (dedup ใช้ id ของบันทึก) ยอมรับไว้ก่อน

## ส่วนที่ 2: หน้า /preview (root เท่านั้น)

### สถาปัตยกรรม (ทางเลือก A ที่ตกลงกัน)

private key ของ VAPID อยู่เฉพาะใน Cron Worker ต่อไป เว็บหลักไม่ได้ถือ key
ปุ่มทดสอบให้เว็บหลักเรียก Worker ผ่านรหัสลับร่วม:

```
เบราว์เซอร์ (root) ── POST /api/preview/* ──▶ เว็บหลัก ── POST {NOTIFIER_URL}/preview/* ──▶ Cron Worker
                       (session + requireRoot)            (Authorization: Bearer NOTIFIER_SECRET)   (ส่ง push / คำนวณ dry-run)
```

- Worker เพิ่ม `fetch` handler รับเฉพาะ `POST /preview/test-push` และ `POST /preview/dry-run`
  ทางอื่นตอบ 404, ไม่มี/รหัสผิดตอบ 401 (เทียบแบบ constant-time), ถ้า Worker ไม่ได้ตั้ง `NOTIFIER_SECRET` ตอบ 503 (ปิดตายไว้ก่อน)
- โค้ดใหม่แยกไฟล์ `cron-notifications/src/preview.ts` ฟังก์ชัน handler รับ dependency (db, send, now) เพื่อทดสอบได้
- เว็บหลักตอบ 503 พร้อมข้อความชัดเจนบนหน้า เมื่อยังไม่ได้ตั้ง `NOTIFIER_URL`/`NOTIFIER_SECRET`
- การเรียกจากเว็บไป Worker มี timeout 10 วินาที และไม่ส่งข้อมูลอ่อนไหวกลับมาที่เบราว์เซอร์
  (ไม่มี endpoint เต็ม, p256dh, auth หรือ secret)

### การเข้าถึง

- เมนู "ทดสอบระบบ" ในแถบข้าง แสดงเฉพาะ root (ใช้ `data-root-only` เดิม) ลิงก์ไป `/preview`
- หน้า `/preview` ตรวจ role จาก DB ฝั่งเซิร์ฟเวอร์ (ไม่เชื่อ client) ถ้าไม่ใช่ root ให้ redirect ไป `/`
- API `/api/preview/*` ใช้ `requireRoot` ทุกตัว (403 สำหรับคนอื่น) ยังไม่ล็อกอิน 401 ตาม middleware เดิม
- หน้าไม่มีลิงก์จากผู้ใช้ทั่วไป แต่ความปลอดภัยอยู่ที่การตรวจฝั่งเซิร์ฟเวอร์ ไม่ใช่การซ่อนเมนู

### ปุ่มทั้ง 3

1. **ส่งแจ้งเตือนทดสอบถึงอุปกรณ์ของฉัน**
   `POST /api/preview/test-push` → Worker `/preview/test-push` body `{ ownerId }` (id ของ root ที่ล็อกอิน ตั้งจาก session ไม่รับจาก client)
   Worker อ่าน subscription ของ owner นั้น ส่งข้อความคงที่ "ทดสอบการแจ้งเตือน" (title/body คงที่ ไม่รับข้อความจากภายนอก)
   ผ่านฟังก์ชัน `sendPush` ตัวเดียวกับ production ลบ subscription ที่ตอบ 404/410 เหมือนเดิม **ไม่เขียน `notification_log`**
   ตอบกลับ `{ devices, sent, failed, pruned }` หน้าแสดงผลเป็นภาษาไทย (เช่น "ส่งสำเร็จ 1 จาก 1 อุปกรณ์", "ยังไม่มีอุปกรณ์ที่สมัคร")
2. **ดูสถานะอุปกรณ์ที่สมัครไว้**
   `GET /api/preview/subscriptions` อ่านตาราง `push_subscriptions` ด้วย session ของ root (RLS จำกัดเฉพาะแถวของตัวเอง)
   แสดงจำนวน, host ของ endpoint (เช่น `fcm.googleapis.com`), วันที่สมัคร และฝั่งเบราว์เซอร์แสดงสิทธิ์ `Notification.permission`
   กับสถานะ service worker ของเครื่องที่เปิดหน้าอยู่ ไม่แสดง key ใดๆ
3. **ดูว่าถ้า cron รันตอนนี้จะส่งอะไรบ้าง**
   `POST /api/preview/dry-run` → Worker `/preview/dry-run` ใช้ `findCandidates(now)` ตัวเดียวกับ production
   แต่ **ไม่ส่งและไม่เขียน `notification_log`** ตอบรายการ `{ kind, title, body, ownerId, alreadySent }`
   (`alreadySent` = มีแถวใน `notification_log` แล้ว) แสดงเป็นตาราง มีเวลาไทยปัจจุบันกำกับ

หน้าตา: ใช้สไตล์เดิมของแอป (การ์ดขาว, ปุ่ม `btn-primary`/`btn-secondary`), รองรับมือถือ (ปุ่มสูงอย่างน้อย 44px,
ไม่ล้นจอ 320px), ผลลัพธ์แสดงใต้ปุ่มแต่ละตัวด้วย `role="status"`

### `.dev.vars`

ตัวแปรใหม่ 2 ตัว:

| ตัวแปร | ไฟล์ | หมายเหตุ |
|---|---|---|
| `NOTIFIER_SECRET` | `.dev.vars` (เว็บ) และ `cron-notifications/.dev.vars` | ค่าเดียวกันทั้งสองไฟล์ สุ่ม 32 ไบต์ (hex) ห้าม commit |
| `NOTIFIER_URL` | `.dev.vars` (เว็บ) เท่านั้น | local = `http://localhost:8787` (พอร์ตของ `wrangler dev`) |

- เพิ่มลงไฟล์จริง `.dev.vars` ทั้งสองไฟล์ที่มีอยู่แล้วในเครื่อง (ไฟล์ gitignore; ไม่พิมพ์ secret ออกหน้าจอ) ใส่ค่าเดียวกัน
- เพิ่มตัวอย่างใน `.dev.vars.example` ทั้งสองไฟล์ (ไม่ใส่ค่าจริง)
- `scripts/setup-local.mjs` สร้าง `NOTIFIER_SECRET` ให้เมื่อ setup ครั้งแรกด้วย
- `astro.config.mjs` ประกาศทั้งสองตัวเป็น `envField.string({ context: 'server', access: 'secret', optional: true })`
  และ `cron-notifications` ประกาศ `NOTIFIER_SECRET?` ใน `NotificationEnv`
- ตอน deploy จริง (นอกขอบเขตรอบนี้): ตั้ง `NOTIFIER_SECRET` เป็น secret ของทั้งสอง Worker และ `NOTIFIER_URL` เป็นที่อยู่ Worker
  (แนะนำ service binding แทน URL สาธารณะเมื่อถึงตอนนั้น) บันทึกไว้ใน `docs/mobile-push-handoff.md`

## การทดสอบ

- **SQL:** `activities_followup_time.test.sql` (ตามด้านบน) และ test เดิมทั้งหมดต้องผ่าน
- **Schema/API (node:test):** รับ/ปฏิเสธรูปแบบเวลา, เวลาโดยไม่มีวันถูกปฏิเสธ, ล้างวันแล้วเวลาถูกล้าง
- **Cron:** ฟังก์ชันคำนวณ "เริ่มส่งได้" (ขอบเขต 07:59/08:00, ก่อน/หลังเวลานัด, เที่ยงคืนเวลาไทย), นัดมีเวลาไม่ส่งก่อนถึงเวลา,
  รันซ้ำไม่ส่งซ้ำ, ใบรับรองไม่ส่งก่อน 08:00 — ใช้ฐานข้อมูล local ด้วยผู้ใช้ชั่วคราวเหมือน test เดิม
- **Preview handler (unit):** 401 เมื่อไม่มี/รหัสผิด, 503 เมื่อไม่ได้ตั้งรหัส, 404 ทางอื่น, test-push ส่งเฉพาะ subscription ของ owner ที่ระบุ
  และไม่เขียน log, dry-run ไม่เรียก `send` และไม่เขียน log (ใช้ `send` ปลอม ไม่ส่ง push จริงตอนทดสอบ)
- **Browser (Playwright):** sales ไม่เห็นเมนู และเข้า `/preview` แล้วถูกส่งกลับ `/`, `/api/preview/*` ตอบ 403; root เห็นเมนูและเปิดหน้าได้;
  เพิ่ม/แก้ไขนัดพร้อมเวลาแล้วแสดงถูก; ปุ่มต่างๆ แสดงผลลัพธ์ (ใช้ Worker ปลอมหรือ stub ที่ `NOTIFIER_URL`)
- ตรวจ `pnpm test`, cron `pnpm test` + `pnpm check`, `pnpm check`, `pnpm build` ทั้งหมดผ่าน
- ทดสอบส่ง push จริงไปเบราว์เซอร์เป็นขั้นตอนมือของผู้ใช้ผ่านหน้า `/preview` (ผมไม่ส่งไปยังอุปกรณ์ของผู้ใช้จริงระหว่างพัฒนา)

## ไฟล์ที่เกี่ยวข้อง (โดยประมาณ)

- `supabase/migrations/20260926090000_activities_followup_time.sql`, `supabase/tests/activities_followup_time.test.sql`
- `ric-crm/src/lib/schemas.ts`, `src/pages/api/activities.ts`, `src/pages/api/activities/[id].ts`, `src/pages/index.astro`
- `ric-crm/src/pages/preview.astro`, `src/pages/api/preview/{test-push,subscriptions,dry-run}.ts`
- `ric-crm/cron-notifications/src/{index,notifications,preview}.ts`, `wrangler.toml`, `scripts/setup-local.mjs`, `.dev.vars.example`
- `ric-crm/.dev.vars.example`, `astro.config.mjs`, `docs/mobile-push-handoff.md`
