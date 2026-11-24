/**
 * Security headers for every response (no extra dependency). All assets are self-hosted
 * (public/vendor), so the Content Security Policy allows only this site. If you add an
 * external script, style, font or API, add its origin to the matching directive below.
 * - img-src data: Bootstrap's CSS draws the close button and form icons as data: SVGs.
 * - No 'unsafe-inline': the theme script lives in public/js/theme-init.js, and the page
 *   changes styles only through element.style (CSSOM), which style-src does not block.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const HEADERS = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  // Same as frame-ancestors 'none', for older browsers.
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
};

export function securityHeaders(req, res, next) {
  res.set(HEADERS);
  // HTTPS only (req.secure follows TRUST_PROXY behind Render's proxy); browsers ignore it over http.
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
}
