# RIC Sales CRM

ระบบ CRM สำหรับ Royal International Certification Co., Ltd.

สร้างด้วย **Astro** + **TailwindCSS** บน **Cloudflare Pages** + **D1**

## ฟีเจอร์

- 🎯 **Pipeline Kanban** — ลาก-วางลีดระหว่าง stage (ลีดใหม่ → ปิดดีล)
- 🔔 **แจ้งเตือนต่ออายุใบรับรอง** — ไฮไลต์ใบรับรองที่กำลังหมดอายุ
- 📋 **บันทึกกิจกรรม** — log โทรศัพท์ / อีเมล / ประชุม / บันทึก
- 📊 **ภาพรวม Dashboard** — KPI และลีดล่าสุด

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Astro (SSR) + TailwindCSS |
| Hosting | Cloudflare Pages |
| Database | Cloudflare D1 (SQLite at edge) |
| Runtime | Cloudflare Workers |

## การ Deploy

### 1. สร้าง D1 Database

```bash
npx wrangler d1 create crm-ric-db
```

คัดลอก `database_id` ที่ได้มาใส่ใน `wrangler.toml`

### 2. Run Migration

```bash
npm run db:migrate          # local
npm run db:migrate:remote   # production
```

### 3. Deploy ไป Cloudflare Pages

```bash
npm run build
npx wrangler pages deploy ./dist --project-name=crm-ric
```

หรือเชื่อม GitHub repo กับ Cloudflare Pages แล้ว deploy อัตโนมัติ

## Development

```bash
npm install
npm run dev    # http://localhost:4321
```

> **Note:** ต้องมี D1 binding ก่อนถึงจะ run ได้ — ใช้ `wrangler dev` แทน `npm run dev` เพื่อ simulate D1

```bash
npx wrangler pages dev ./dist --d1=DB=crm-ric-db
```

## Structure

```
crm-ric/
├── src/
│   ├── pages/
│   │   ├── index.astro          # Main CRM UI
│   │   └── api/
│   │       ├── leads.ts         # GET all, POST create
│   │       ├── leads/[id].ts    # PUT update, DELETE
│   │       ├── activities.ts    # GET all, POST create
│   │       ├── renewals.ts      # GET all, POST create
│   │       └── renewals/[id].ts # DELETE
│   ├── styles/
│   │   └── global.css
│   └── env.d.ts
├── schema.sql        # D1 database schema
├── wrangler.toml     # Cloudflare config
├── astro.config.mjs
└── tailwind.config.mjs
```

## Brand

- Primary: `#B5121B` (RIC Burgundy Red)
- Sidebar: `#1D1819`
- Font: DM Sans + IBM Plex Mono
