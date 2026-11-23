import { HttpError } from '../utils/httpError.js';

// Upper bound on tracked visitors, so a flood of new IPs can't grow memory without limit.
const MAX_TRACKED = 10000;

function formatWait(seconds) {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * Small in-memory rate limiter (fixed window) per visitor IP. Keeps the shared
 * free Gemini quota and the server's CPU safe from one visitor or bot.
 * @param {{ max: number, windowMs: number, action: string, now?: () => number }} options
 *   action: what is limited, for the message ("questions", "uploads").
 */
export function createRateLimiter({ max, windowMs, action, now = Date.now }) {
  const hits = new Map(); // key -> { count, resetAt }

  function removeExpired(time) {
    for (const [key, entry] of hits) if (entry.resetAt <= time) hits.delete(key);
  }

  function limiter(req, res, next) {
    if (!max || max <= 0) return next(); // 0 turns the limit off
    const time = now();
    const key = req.ip || 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= time) {
      if (hits.size >= MAX_TRACKED) removeExpired(time);
      if (hits.size >= MAX_TRACKED) hits.clear();
      entry = { count: 0, resetAt: time + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - time) / 1000));
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.set('RateLimit-Reset', String(retryAfter));
    if (entry.count > max) {
      res.set('Retry-After', String(retryAfter));
      const error = new HttpError(429, 'RATE_LIMITED', `You're sending ${action} too fast. Please wait ${formatWait(retryAfter)} and try again.`);
      error.retryAfter = retryAfter;
      return next(error);
    }
    next();
  }

  limiter.reset = () => hits.clear();
  limiter.size = () => hits.size;
  return limiter;
}
