import './env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

let server;
let base;
before(async () => {
  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

function upload(files, accept) {
  const body = new FormData();
  for (const [name, text] of files) body.append('files', new Blob([text], { type: 'text/plain' }), name);
  return fetch(`${base}/api/documents`, { method: 'POST', body, headers: accept ? { accept } : {} });
}
const events = async (response) => (await response.text()).trim().split('\n').map((line) => JSON.parse(line));

test('with Accept: application/x-ndjson an upload streams progress, then the result', async () => {
  const long = 'Parking costs 5 dollars per day. '.repeat(200);
  const response = await upload([['a.txt', long], ['b.txt', 'The meeting is on Monday.']], 'application/x-ndjson');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  assert.match(response.headers.get('set-cookie'), /docchat_sid=/);

  const list = await events(response);
  const result = list.at(-1);
  assert.equal(result.type, 'result');
  assert.equal(result.status, 201);
  assert.deepEqual(result.documents.map((d) => d.name), ['a.txt', 'b.txt']);

  const progress = list.slice(0, -1);
  assert.ok(progress.every((e) => e.type === 'progress' && e.files === 2));
  const first = progress.filter((e) => e.file === 1);
  assert.equal(first[0].stage, 'reading');
  const lastEmbedding = first.filter((e) => e.stage === 'embedding').at(-1);
  assert.equal(lastEmbedding.done, lastEmbedding.total);
  assert.equal(lastEmbedding.total, result.documents[0].chunks);
  assert.ok(progress.some((e) => e.file === 2));
});

test('a streamed upload where every file fails ends with a 422 result', async () => {
  const response = await upload([['empty.txt', '   ']], 'application/x-ndjson');
  const result = (await events(response)).at(-1);
  assert.equal(result.type, 'result');
  assert.equal(result.status, 422);
  assert.equal(result.code, 'EMPTY_FILE');
});

test('errors before any file is processed stay plain JSON', async () => {
  const response = await upload([['photo.png', 'x']], 'application/x-ndjson');
  assert.equal(response.status, 415);
  assert.equal((await response.json()).code, 'UNSUPPORTED_FILE');
});
