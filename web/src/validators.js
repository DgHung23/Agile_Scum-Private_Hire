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

/* ---------- cards (mirror of server/src/services/payments.js) ---------- */
export const onlyDigits = (s) => String(s ?? '').replace(/\D/g, '');

export function cardBrand(number) {
  const n = onlyDigits(number);
  if (/^4/.test(n)) return 'visa';
  if (/^(5[1-5]|2(2[2-9][1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720))/.test(n)) return 'mastercard';
  if (/^3[47]/.test(n)) return 'amex';
  return null;
}
export const BRAND_NAME = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express' };

export function luhn(number) {
  const n = onlyDigits(number);
  if (n.length < 12) return false;
  let sum = 0;
  let dbl = false;
  for (let i = n.length - 1; i >= 0; i--) {
    let d = Number(n[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** "4242424242424242" -> "4242 4242 4242 4242" (Amex 4-6-5) */
export function formatCardNumber(value) {
  const n = onlyDigits(value).slice(0, 19);
  if (/^3[47]/.test(n)) return [n.slice(0, 4), n.slice(4, 10), n.slice(10, 15)].filter(Boolean).join(' ');
  return n.replace(/(.{4})/g, '$1 ').trim();
}

/** "1230" -> "12/30" */
export function formatExpiry(value) {
  const d = onlyDigits(value).slice(0, 4);
  return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
}

export function parseExpiry(value) {
  const [m, y] = String(value).split('/');
  return { expMonth: Number(m), expYear: y ? 2000 + Number(y) : NaN };
}

export const v2 = {
  cardNumber: (val) => {
    const n = onlyDigits(val);
    const b = cardBrand(n);
    if (!n) return 'Card number is required';
    if (!b) return 'We accept Visa, Mastercard and American Express';
    if (b === 'amex' ? n.length !== 15 : n.length !== 16) return b === 'amex' ? 'American Express numbers have 15 digits' : 'Card numbers have 16 digits';
    if (!luhn(n)) return 'That card number is not valid. Check for a typing mistake.';
    return '';
  },
  expiry: (val) => {
    if (!val) return 'Expiry date is required';
    const { expMonth, expYear } = parseExpiry(val);
    if (!/^\d{2}\/\d{2}$/.test(val) || expMonth < 1 || expMonth > 12) return 'Enter the expiry as MM/YY';
    if (Date.UTC(expYear, expMonth, 1) <= Date.now()) return 'This card has expired';
    return '';
  },
  cvv: (brand) => (val) => {
    const want = brand === 'amex' ? 4 : 3;
    if (!val) return 'Security code is required';
    return (want === 4 ? /^\d{4}$/ : /^\d{3}$/).test(val) ? '' : `Security code must be ${want} digits`;
  },
};

export function validateCardForm(c) {
  const brand = cardBrand(c.number);
  const e = {};
  const n = v2.cardNumber(c.number);
  if (n) e.number = n;
  const x = v2.expiry(c.expiry);
  if (x) e.expiry = x;
  const cv = v2.cvv(brand)(c.cvv);
  if (cv) e.cvv = cv;
  if (!String(c.holder || '').trim() || c.holder.trim().length < 2) e.holder = 'Name on card is required';
  return e;
}
