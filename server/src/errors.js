/** Application error with an HTTP status and a stable machine-readable code (useful for the future mobile app). */
export class HttpError extends Error {
  constructor(status, message, code = 'error', details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.extra = null;
  }
  /** Attach extra machine-readable data (e.g. alternative times) to the error response. */
  withExtra(extra) {
    this.extra = extra;
    return this;
  }
}
export const badRequest = (m, details) => new HttpError(400, m, 'bad_request', details);
export const unauthorized = (m = 'Please log in to continue') => new HttpError(401, m, 'unauthorized');
export const forbidden = (m = 'You do not have access to this') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'Not found') => new HttpError(404, m, 'not_found');
export const conflict = (m, code = 'conflict') => new HttpError(409, m, code);
