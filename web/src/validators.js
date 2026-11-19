// Client-side checks mirror server/src/schemas.js so people see problems immediately.
// The server remains the source of truth and re-validates everything.
export const v = {
  required: (label) => (val) => (String(val ?? '').trim() ? '' : `${label} is required`),
  email: (val) => {
    if (!String(val ?? '').trim()) return 'Email is required';
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(val.trim()) ? '' : 'Enter a valid email address, like name@example.com';
  },
  phone: (val) => {
    const s = String(val ?? '').trim();
    if (!s) return 'Telephone number is required';
    return /^\+?[0-9 ()-]{7,20}$/.test(s) && s.replace(/\D/g, '').length >= 7
      ? ''
      : 'Enter a valid telephone number, like 07700 900123';
  },
  postcode: (val) => {
    const s = String(val ?? '').trim();
    if (!s) return 'Postcode is required';
    return /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}$/.test(s) ? '' : 'Enter a valid UK postcode, like SW1A 1AA';
  },
  password: (val) => {
    if (!val) return 'Password is required';
    if (val.length < 8) return 'Use at least 8 characters';
    if (!/[A-Za-z]/.test(val) || !/\d/.test(val)) return 'Include at least one letter and one number';
    return '';
  },
};

export function passwordStrength(pw = '') {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(s, 4);
}

/** Run a { field: validatorFn } map over values -> { field: message } (empty messages dropped). */
export function validate(values, rules) {
  const out = {};
  for (const [k, fn] of Object.entries(rules)) {
    const msg = fn(values[k]);
    if (msg) out[k] = msg;
  }
  return out;
}
