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

test('the page and the API send the security headers', async () => {
  for (const path of ['/', '/api/health', '/api/nope']) {
    const response = await fetch(`${base}${path}`);
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/, path);
    assert.match(csp, /script-src 'self'(;|$)/, path);
    assert.match(csp, /frame-ancestors 'none'/, path);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/, path);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(response.headers.get('x-frame-options'), 'DENY', path);
    // Plain http: no HSTS.
    assert.equal(response.headers.get('strict-transport-security'), null, path);
  }
});

test('the page has no inline scripts and loads nothing from other sites', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.equal([...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)].length, 0, 'inline <script>');
  assert.doesNotMatch(html, /\s(?:src|href)="(?:https?:)?\/\//, 'external asset URL');
  assert.doesNotMatch(html, /\sstyle="|\son[a-z]+="/, 'inline style or event handler');
  for (const asset of html.matchAll(/\s(?:src|href)="([^"#]+\.(?:js|css))"/g)) {
    assert.equal((await fetch(`${base}/${asset[1]}`)).status, 200, asset[1]);
  }
});

test('versioned vendor files are cached for a year, the page is not', async () => {
  const vendor = await fetch(`${base}/vendor/bootstrap/5.3.3/css/bootstrap.min.css`);
  assert.equal(vendor.status, 200);
  assert.match(vendor.headers.get('cache-control'), /max-age=31536000.*immutable/);
  assert.doesNotMatch((await fetch(`${base}/`)).headers.get('cache-control'), /immutable/);
});
