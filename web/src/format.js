const TZ = 'Europe/London';

export const money = (n) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number(n || 0));

export const fmtDate = (d) =>
  d
    ? new Intl.DateTimeFormat('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: TZ,
      }).format(new Date(d))
    : '';

export const fmtTime = (d) =>
  d ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ }).format(new Date(d)) : '';

export const fmtDateTime = (d) => (d ? `${fmtDate(d)}, ${fmtTime(d)}` : '');

export const fmtShort = (d) =>
  d
    ? new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: TZ,
      }).format(new Date(d))
    : '';

/** Convert yyyy-mm-dd + HH:mm entered as London wall-clock time into an ISO instant. */
export function londonToIso(date, time) {
  if (!date || !time) return null;
  const guess = new Date(`${date}T${time}:00Z`);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(guess);
  const g = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(g.year, g.month - 1, g.day, Number(g.hour) % 24, g.minute, g.second);
  const offset = asUtc - guess.getTime();
  return new Date(guess.getTime() - offset).toISOString();
}

export const todayLondon = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

// Booking states (report Figure 25).
export const STATUS_LABEL = {
  pending_payment: 'Waiting for payment',
  confirmed: 'Confirmed',
  assigned: 'Driver assigned',
  on_route: 'On route',
  arrived: 'Arrived',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  company_cancelled: 'Cancelled by us',
  no_show: 'No-show',
  interrupted: 'Interrupted',
  abandoned: 'Not paid',
};
export const STATUS_TONE = {
  pending_payment: 'amber',
  confirmed: 'blue',
  assigned: 'blue',
  on_route: 'amber',
  arrived: 'amber',
  in_progress: 'amber',
  completed: 'green',
  cancelled: 'red',
  company_cancelled: 'red',
  no_show: 'red',
  interrupted: 'red',
  abandoned: '',
};
export const ACCESSIBILITY_LABEL = {
  wheelchair: 'Wheelchair-accessible vehicle',
  assistance_dog: 'Assistance dog',
  help_find_car: 'Help to find the car',
};
export const PAYMENT_STATUS_LABEL = {
  pending: 'Waiting for payment',
  paid: 'Paid',
  due_cash: 'Cash to the driver',
  invoice: 'Company invoice',
  unpaid: 'Not paid',
  refunded: 'Refunded',
  partially_refunded: 'Partly refunded',
};
export const CHANNEL_LABEL = { online: 'Online', phone: 'Phone', in_person: 'In person' };

/** ISO instant -> { date: 'yyyy-mm-dd', time: 'HH:mm' } in London time (for form inputs). */
export function londonParts(iso) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const g = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { date: `${g.year}-${g.month}-${g.day}`, time: `${g.hour === '24' ? '00' : g.hour}:${g.minute}` };
}
