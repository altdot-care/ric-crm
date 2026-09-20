import { z } from 'zod';

const text = (max: number) => z.string().trim().max(max);
const isoDate = z.iso.date();

export const leadInput = z.object({
  company: text(200).min(1),
  contact: text(200),
  phone: text(50),
  email: z.union([z.literal(''), z.email().max(200)]),
  cert: text(100),
  stage: z.enum(['new', 'contacted', 'quoted', 'negotiating', 'won', 'lost']),
  value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  notes: text(5000),
  owner_id: z.uuid(),
});
export const leadCreate = leadInput.partial({
  contact: true,
  phone: true,
  email: true,
  cert: true,
  stage: true,
  value: true,
  notes: true,
  owner_id: true,
});
export const leadUpdate = leadInput.partial();

export const activityCreate = z.object({
  type: z.enum(['call', 'email', 'meeting', 'note']).default('note'),
  company: text(200).default(''),
  description: text(5000).min(1),
  date: isoDate.optional(),
  followup: z.union([isoDate, z.literal('')]).optional(),
  owner_id: z.uuid().optional(),
});

export const renewalCreate = z.object({
  company: text(200).min(1),
  cert: text(100).min(1),
  expiry: isoDate,
  owner_id: z.uuid().optional(),
});

export const loginInput = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
});

// Root accounts are never created or granted from the app, so only these two roles are accepted.
const assignableRole = z.enum(['admin', 'sales']);

export const userCreate = z.object({
  email: z.email().max(200),
  full_name: text(200).min(1),
  // bcrypt only uses the first 72 bytes, so longer passwords would be silently truncated.
  password: z.string().min(8).max(72),
  role: assignableRole,
});

export const userRoleUpdate = z.object({ role: assignableRole });

export const uuidParam = z.uuid();
