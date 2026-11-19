import { z } from 'zod';

const trimmed = (label, min = 1, max = 120) =>
  z
    .string({ error: `${label} is required`, error: `${label} is required` })
    .trim()
    .min(min, `${label} is required`)
    .max(max, `${label} is too long`);

export const emailSchema = z
  .string({ error: 'Email is required' })
  .trim()
  .toLowerCase()
  .min(1, 'Email is required')
  .max(200)
  .email('Enter a valid email address, like name@example.com');

export const phoneSchema = z
  .string({ error: 'Telephone number is required' })
  .trim()
  .min(1, 'Telephone number is required')
  .regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid telephone number, like 07700 900123')
  .refine((v) => v.replace(/\D/g, '').length >= 7, 'Enter a valid telephone number, like 07700 900123');

export const passwordSchema = z
  .string({ error: 'Password is required' })
  .min(12, 'Use at least 12 characters')
  .max(72, 'Use at most 72 characters')
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Include at least one letter and one number');

const postcodeSchema = trimmed('Postcode', 1, 12).regex(
  /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}$/,
  'Enter a valid UK postcode, like SW1A 1AA',
);

export const profileFields = {
  fullName: trimmed('Full name', 1, 100),
  email: emailSchema,
  phone: phoneSchema,
  addressLine: trimmed('Address', 1, 160),
  city: trimmed('City', 1, 80),
  postcode: postcodeSchema,
};

export const secretWordSchema = z
  .string()
  .trim()
  .min(4, 'Use at least 4 characters')
  .max(40, 'Use at most 40 characters');

export const registerSchema = z.object({
  ...profileFields,
  password: passwordSchema,
  notifyPref: z.enum(['email', 'text', 'both']).optional(),
  marketingConsent: z.boolean().optional(), // ID-11 criterion 3: registering works with the box unticked
  secretWord: secretWordSchema.optional().or(z.literal('')),
});

export const profileUpdateSchema = z.object({
  ...profileFields,
  notifyPref: z.enum(['email', 'text', 'both']).optional(),
  marketingConsent: z.boolean().optional(),
  currentPassword: z.string().optional(), // ID-15: needed when the email address changes
});

export const loginSchema = z.object({
  email: z.string({ error: 'Email is required' }).trim().toLowerCase().min(1, 'Email is required'),
  password: z.string({ error: 'Password is required' }).min(1, 'Password is required'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: passwordSchema,
});

export const normalisePostcode = (p) => {
  const s = p.replace(/\s+/g, '').toUpperCase();
  return `${s.slice(0, -3)} ${s.slice(-3)}`;
};
