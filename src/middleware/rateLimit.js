import { rateLimit } from 'express-rate-limit';
import { HttpError } from '../utils/httpError.js';

function formatWait(seconds) {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * Per-visitor rate limit (express-rate-limit, in memory). Keeps the shared free Gemini
 * quota and the server's CPU safe from one visitor or bot. Visitors are told apart by
 * req.ip, so `trust proxy` must match the host (TRUST_PROXY); IPv6 visitors are grouped
 * by /64, the block one connection usually gets.
 * @param {{ max: number, windowMs: number, action: string }} options
 *   max 0 turns the limit off; action names what is limited, for the message ("questions", "uploads").
 */
export function createRateLimiter({ max, windowMs, action }) {
  return rateLimit({
    windowMs,
    limit: max || 1,
    skip: () => !max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ipv6Subnet: 64,
    handler(req, res, next) {
      const retryAfter = Math.max(1, Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000));
      res.set('Retry-After', String(retryAfter));
      next(new HttpError(429, 'RATE_LIMITED', `You're sending ${action} too fast. Please wait ${formatWait(retryAfter)} and try again.`));
    },
  });
}
