import { ZodError } from 'zod';
import { HttpError } from '../errors.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.originalUrl.split("?")[0]}` } });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    const fields = {};
    for (const issue of err.issues) {
      const key = issue.path.join('.') || '_';
      if (!fields[key]) fields[key] = issue.message;
    }
    return res.status(400).json({
      error: { code: 'validation_error', message: 'Please check the highlighted fields', fields },
    });
  }
  if (err instanceof HttpError) {
    return res
      .status(err.status)
      .json({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { fields: err.details } : {}),
          ...(err.extra || {}),
        },
      });
  }
  // Postgres: unique violation / exclusion violation (double booking) / FK
  if (err?.code === '23505') {
    return res.status(409).json({ error: { code: 'duplicate', message: 'That value already exists' } });
  }
  if (err?.code === '23P01') {
    return res
      .status(409)
      .json({ error: { code: 'unavailable', message: 'That cab or driver is already booked for those times' } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'bad_json', message: 'Request body is not valid JSON' } });
  }
  console.error('[error]', err);
  res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong on our side' } });
}
