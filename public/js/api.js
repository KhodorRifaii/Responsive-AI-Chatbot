// Small wrapper around the backend API. Every call resolves to JSON or throws an Error with a readable message.

const NDJSON_TYPE = 'application/x-ndjson';
const CONNECTION_LOST = 'The connection was lost before the server finished. Please try again.';

function toError(data, status) {
  const error = new Error(data.error || `Request failed (${status}).`);
  error.code = data.code;
  error.sessionExpired = Boolean(data.sessionExpired);
  return error;
}

async function send(url, options) {
  try {
    return await fetch(url, options);
  } catch {
    throw new Error('Cannot reach the server. Check that it is running and try again.');
  }
}

async function readJson(response) {
  let data = {};
  try {
    data = await response.json();
  } catch {
    // Non-JSON response; handled below.
  }
  if (!response.ok) throw toError(data, response.status);
  return data;
}

async function request(url, options = {}) {
  return readJson(await send(url, options));
}

/** Call onEvent for each line of a newline-delimited JSON response, as it arrives. */
async function readNdjson(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const parse = (line) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(CONNECTION_LOST);
    }
  };
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch {
      throw new Error(CONNECTION_LOST);
    }
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onEvent(parse(line));
    }
    if (chunk.done) break;
  }
  if (buffer.trim()) onEvent(parse(buffer.trim()));
}

/**
 * Like request(), but asks the server to stream newline-delimited JSON events. onEvent gets
 * every progress or token event; the call resolves to the final "result" / "done" event.
 * A plain JSON answer (an error before the stream started, or an older server) is handled
 * exactly like request().
 */
async function streamRequest(url, options, onEvent) {
  const response = await send(url, { ...options, headers: { ...options.headers, Accept: NDJSON_TYPE } });
  if (!(response.headers.get('content-type') ?? '').includes(NDJSON_TYPE)) return readJson(response);

  let final = null;
  await readNdjson(response, (event) => {
    if (event.type === 'result' || event.type === 'done' || event.type === 'error') final = event;
    else onEvent?.(event);
  });
  if (!final) throw new Error(CONNECTION_LOST);
  if (final.type === 'error' || final.status >= 400) throw toError(final, final.status);
  return final;
}

/** onProgress({ file, files, name, stage: 'reading' | 'embedding', done, total }) while the server works. */
export function uploadDocuments(files, { onProgress } = {}) {
  const body = new FormData();
  for (const file of files) body.append('files', file);
  return streamRequest('/api/documents', { method: 'POST', body }, onProgress);
}

export function getDocuments() {
  return request('/api/documents');
}

/** onToken(text) gets the answer while it is written; resolves to the final { answer, sources }. */
export function askQuestion(question, history = [], { onToken } = {}) {
  return streamRequest('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, history }),
  }, (event) => {
    if (event.type === 'token') onToken?.(event.text);
  });
}

export function getHealth() {
  return request('/api/health');
}
