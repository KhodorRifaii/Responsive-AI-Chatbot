// Streamed answers as newline-delimited JSON (one event per line). Clients opt in with
// "Accept: application/x-ndjson"; without it the routes answer with plain JSON as before.

export const NDJSON_TYPE = 'application/x-ndjson';

export function wantsNdjson(req) {
  return (req.get('accept') ?? '').includes(NDJSON_TYPE);
}

/** Send the headers now so events reach the browser as they happen (no proxy buffering). */
export function startNdjson(res) {
  res.status(200).set({
    'Content-Type': `${NDJSON_TYPE}; charset=utf-8`,
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
}

export function writeEvent(res, event) {
  if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
}

/** End a started stream after an unexpected error (the status line was already sent). */
export function endWithError(res, error) {
  console.error(error);
  writeEvent(res, { type: 'error', status: 500, error: 'Something went wrong on the server. Please try again.' });
  res.end();
}
