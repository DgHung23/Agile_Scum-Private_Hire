/** Parse req.body / req.query with a zod schema; throws ZodError (handled centrally). */
export const body = (schema) => (req, _res, next) => {
  req.body = schema.parse(req.body ?? {});
  next();
};
export const queryOf = (schema) => (req, _res, next) => {
  // Express 5 exposes req.query as a getter-only property, so redefine it with the parsed (typed) values.
  Object.defineProperty(req, 'query', { value: schema.parse(req.query ?? {}), writable: true, configurable: true });
  next();
};
/** Wrap async route handlers so rejections reach the error middleware (Express 4). */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
