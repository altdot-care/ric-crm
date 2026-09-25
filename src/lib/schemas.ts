import { z } from 'zod';
import { isPushEndpoint } from './push-endpoint.ts';

const text = (max: number) => z.string().trim().max(max);
const isoDate = z.iso.date();
// Digits only, up to 10 — matches the UI's on-input filter.
const phone = z.string().regex(/^\d{0,10}$/, 'ตัวเลขเท่านั้น ไม่เกิน 10 หลัก');

// Nullable, no default: absent means "not collected", distinct from an intentional empty string.
const optionalText = (max: number) => z.union([z.null(), text(max)]).optional();
const optionalUrl = (max: number) => z.union([z.null(), z.url().max(max)]).optional();

export const leadInput = z.object({
  company_id: z.uuid(),
  primary_contact_id: z.union([z.null(), z.uuid()]).optional(),
  cert: z.array(text(100)).max(10).default([]),
  stage: z.enum(['new', 'contacted', 'quoted', 'negotiating', 'won', 'lost']),
  value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  notes: text(5000),
  quote_link: optionalUrl(500),
  owner_id: z.uuid(),
});
export const leadCreate = leadInput.partial({
  primary_contact_id: true,
  cert: true,
  stage: true,
  value: true,
  notes: true,
  quote_link: true,
  owner_id: true,
});
export const leadUpdate = leadInput.partial();

// Next-action log: multiple line items per lead (replaces the old single next_action /
// next_action_due columns). "completed" is a boolean on the wire; the API route translates
// it to a server-set completed_at timestamp rather than trusting a client-supplied one.
export const nextActionCreate = z.object({
  lead_id: z.uuid(),
  description: text(200).min(1),
  due_date: z.union([z.null(), isoDate]).optional(),
  owner_id: z.uuid().optional(),
});
export const nextActionUpdate = z.object({
  description: text(200).min(1).optional(),
  due_date: z.union([z.null(), isoDate]).optional(),
  completed: z.boolean().optional(),
});

export const companyInput = z.object({
  name: text(200).min(1),
  phone,
  email: z.union([z.literal(''), z.email().max(200)]),
  tax_id: optionalText(20),
  website: optionalUrl(500),
  address1: optionalText(200),
  address2: optionalText(200),
  sub_district: optionalText(100),
  district: optionalText(100),
  province: optionalText(100),
  postcode: optionalText(50),
  notes: optionalText(2000),
  owner_id: z.uuid().optional(),
});
export const companyCreate = companyInput.partial({
  phone: true,
  email: true,
  tax_id: true,
  website: true,
  address1: true,
  address2: true,
  sub_district: true,
  district: true,
  province: true,
  postcode: true,
  notes: true,
  owner_id: true,
});
export const companyUpdate = companyInput.partial();

export const contactInput = z.object({
  company_id: z.uuid(),
  full_name: text(200).min(1),
  position: text(100),
  phone,
  email: z.union([z.literal(''), z.email().max(200)]),
  gender: optionalText(50),
  occupation: optionalText(200),
  postcode: optionalText(50),
  address1: optionalText(200),
  address2: optionalText(200),
  sub_district: optionalText(100),
  district: optionalText(100),
  province: optionalText(100),
  status: z.number().int().min(0).max(32767).default(1),
  owner_id: z.uuid(),
});
export const contactCreate = contactInput.partial({
  position: true,
  phone: true,
  email: true,
  gender: true,
  occupation: true,
  postcode: true,
  address1: true,
  address2: true,
  sub_district: true,
  district: true,
  province: true,
  status: true,
  owner_id: true,
});
// company_id is intentionally excluded: moving a contact between companies isn't a real use
// case, and forbidding it via update removes the whole class of primary_contact_id ∈ company_id
// invariant problems that an update-able company_id would reopen.
export const contactUpdate = contactInput.omit({ company_id: true }).partial();

export const activityCreate = z.object({
  lead_id: z.uuid(),
  // stage_change is written only by the database trigger (security definer, bypasses this
  // schema entirely) — never accept it from a client request.
  type: z.enum(['call', 'email', 'meeting', 'note']).default('note'),
  description: text(5000).min(1),
  date: isoDate.optional(),
  followup: z.union([isoDate, z.literal('')]).optional(),
  owner_id: z.uuid().optional(),
});

export const renewalCreate = z.object({
  company_id: z.uuid(),
  cert: text(100).min(1),
  audit_due: isoDate,
  expiry: isoDate,
  owner_id: z.uuid().optional(),
});
export const renewalUpdate = renewalCreate.partial();

export const pushSubscriptionCreate = z.object({
  endpoint: z.url().max(2048).refine(isPushEndpoint, 'Unsupported push service'),
  p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}={0,1}$/),
  auth: z.string().regex(/^[A-Za-z0-9_-]{22}={0,2}$/),
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
