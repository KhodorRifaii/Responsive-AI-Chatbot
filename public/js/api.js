// Small wrapper around the backend API. Every call resolves to JSON or throws an Error with a readable message.

async function request(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error('Cannot reach the server. Check that it is running and try again.');
  }

  let data = {};
  try {
    data = await response.json();
  } catch {
    // Non-JSON response; handled below.
  }

  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.code = data.code;
    throw error;
  }
  return data;
}

export function uploadDocuments(files) {
  const body = new FormData();
  for (const file of files) body.append('files', file);
  return request('/api/documents', { method: 'POST', body });
}

export function getDocuments() {
  return request('/api/documents');
}

export function askQuestion(question, history = []) {
  return request('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, history }),
  });
}
