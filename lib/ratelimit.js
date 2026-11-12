// Best-effort per-IP rate limiter, shared by the API routes.
// Serverless instances are short-lived and can run in parallel, so this is a
// speed bump, not a wall. (A real one would use a shared store like Redis/KV.)

export function createRateLimiter(limit, windowMs) {
  const hits = new Map();
  return function isRateLimited(ip) {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(ip, recent);
    return recent.length > limit;
  };
}

export function clientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
}
