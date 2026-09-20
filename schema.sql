-- RIC CRM Database Schema
-- Run: npm run db:migrate (local) or npm run db:migrate:remote (production)

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  contact TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  cert TEXT DEFAULT '',
  stage TEXT DEFAULT 'new',
  value INTEGER DEFAULT 0,
  assigned TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  type TEXT DEFAULT 'note',
  company TEXT DEFAULT '',
  description TEXT NOT NULL,
  date TEXT NOT NULL,
  followup TEXT DEFAULT '',
  by_user TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS renewals (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  cert TEXT NOT NULL,
  expiry TEXT NOT NULL,
  owner TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

-- Seed data (optional, run manually after migration)
-- INSERT INTO leads VALUES ('l1','บริษัท ทดสอบ จำกัด','คุณสมชาย','081-234-5678','somchai@test.co.th','ISO 9001','new',250000,'นายก','',strftime('%s','now')*1000,strftime('%s','now')*1000);
