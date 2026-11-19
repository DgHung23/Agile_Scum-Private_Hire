/** Parse req.body / req.query with a zod schema; throws ZodError (handled centrally). */
export const body = (schema) => (req, _res, next) => {
  req.body = schema.parse(req.body ?? {});
  next();
};
export const queryOf = (schema) => (req, _res, next) => {
  req.query = schema.parse(req.query ?? {});
  next();
};
/** Wrap async route handlers so rejections reach the error middleware (Express 4). */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
