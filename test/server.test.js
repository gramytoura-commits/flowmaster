const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

test('API validates, executes, redacts, persists and cancels registered flows', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-runner-'));
  fs.mkdirSync(path.join(root, 'flows'));
  fs.writeFileSync(path.join(root, 'flows', 'registry.json'), JSON.stringify([{ id: 'fixture', name: 'Fixture', script: 'fixture.js', fields: [{ name: 'NAME', label: 'Name', required: true }, { name: 'SECRET', label: 'Secret', secret: true }] }]));
  fs.writeFileSync(path.join(root, 'flows', 'fixture.js'), "console.log(process.env.NAME, process.env.SECRET); setTimeout(() => {}, process.env.NAME === 'slow' ? 20000 : 30);");
  const app = createApp({ root });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = data => fetch(`${base}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  try {
    assert.equal((await fetch(`${base}/api/flows`).then(r => r.json()))[0].script, undefined);
    assert.equal((await post({ flowId: '../server', variables: {} })).status, 400);
    assert.equal((await post({ flowId: 'fixture', variables: {} })).status, 400);
    assert.equal((await post({ flowId: 'fixture', variables: { NAME: 'x', NODE_OPTIONS: '--bad' } })).status, 400);
    assert.equal((await fetch(`${base}/api/runs`, { method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    const response = await post({ flowId: 'fixture', variables: { NAME: 'hello', SECRET: 'private-value' } });
    assert.equal(response.status, 202);
    const run = await response.json();
    let finished;
    for (let i = 0; i < 100; i++) {
      finished = await fetch(`${base}/api/runs/${run.id}`).then(r => r.json());
      if (finished.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(finished.status, 'succeeded');
    assert.match(finished.logs, /hello \[REDACTED\]/);
    assert.ok(!JSON.stringify(finished).includes('private-value'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data', 'runs', run.id, 'run.json'))).status, 'succeeded');
    const slow = await post({ flowId: 'fixture', variables: { NAME: 'slow' } }).then(r => r.json());
    const cancelled = await fetch(`${base}/api/runs/${slow.id}/cancel`, { method: 'POST' }).then(r => r.json());
    assert.equal(cancelled.status, 'cancelled');
    assert.equal((await fetch(`${base}/.env`)).status, 404);
  } finally {
    app.stop();
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hosted origin accepts its proxy host and rejects cross-origin writes', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-hosted-'));
  const app = createApp({ dataDir, appOrigin: 'https://flow.example.com' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (url, headers, method = 'GET') => new Promise((resolve, reject) => {
    const req = require('node:http').request(base + url, { headers, method }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  try {
    assert.equal(await request('/api/flows', { Host: 'flow.example.com', Origin: 'https://flow.example.com' }), 200);
    assert.equal(await request('/api/flows', { Host: 'other.example.com' }), 403);
    assert.equal(await request('/api/runs', { Host: 'flow.example.com', Origin: 'https://evil.example' }, 'POST'), 403);
    assert.equal(await request('/health', { Host: 'container' }), 200);
  } finally { app.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
