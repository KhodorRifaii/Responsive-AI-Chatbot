import { getSession, createSession } from '../services/vectorStore.js';

export const SESSION_COOKIE = 'docchat_sid';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function readSessionId(req) {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=');
  }
  return '';
}

/**
 * Finds the visitor's session from an httpOnly cookie. The cookie is not
 * readable by page scripts, and ids are created by the server only: an unknown
 * or malformed id is ignored and a new session is issued when one is needed.
 * Adds req.docSession (or null) and req.ensureDocSession().
 */
export function sessionMiddleware(req, res, next) {
  const id = readSessionId(req);
  req.docSession = UUID.test(id) ? getSession(id) : null;
  req.ensureDocSession = () => {
    if (!req.docSession) {
      req.docSession = createSession();
      res.cookie(SESSION_COOKIE, req.docSession.id, {
        httpOnly: true,
        sameSite: 'lax',
        secure: req.secure,
        path: '/',
      });
    }
    return req.docSession;
  };
  next();
}
