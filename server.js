const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID, createHash, timingSafeEqual } = require('node:crypto');

function createApp({ root = __dirname, dataDir = path.join(root, 'data', 'runs'), timeoutMs = 600000, appOrigin = process.env.APP_ORIGIN, integrationKey = process.env.EMAILBOT_INTEGRATION_KEY } = {}) {
  const hostedOrigin = appOrigin ? new URL(appOrigin).origin : null;
  const readRegistry = () => JSON.parse(fs.readFileSync(path.join(root, 'flows', 'registry.json'), 'utf8'));
  fs.mkdirSync(dataDir, { recursive: true });
  const runs = new Map();
  const children = new Map();
  for (const id of fs.readdirSync(dataDir)) {
    if (!/^[\w-]{1,80}$/.test(id)) continue;
    try {
      const run = JSON.parse(fs.readFileSync(path.join(dataDir, id, 'run.json'), 'utf8'));
      if (run.id !== id) continue;
      if (run.status === 'running') { run.status = 'interrupted'; run.finishedAt = new Date().toISOString(); }
      runs.set(run.id, run);
    } catch {}
  }
  const persist = run => fs.writeFileSync(path.join(dataDir, run.id, 'run.json'), JSON.stringify(run, null, 2));
  const publicFlow = ({ script, ...flow }) => flow;
  const reply = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || '';
      if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { status: 'ok' });
      const localHost = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
      if (!localHost && (!hostedOrigin || host !== new URL(hostedOrigin).host)) return reply(res, 403, { error: 'Host not allowed' });
      const allowedOrigin = localHost ? `http://${host}` : hostedOrigin;
      if (req.headers.origin && req.headers.origin !== allowedOrigin) return reply(res, 403, { error: 'Origin not allowed' });
      const url = new URL(req.url, `http://${host}`);
      const integrationRequest = req.headers['x-emailbot-key'] !== undefined;
      const integrationOwner = String(req.headers['x-emailbot-owner'] || '');
      const serviceAuthorized = () => !!integrationKey && integrationKey.length >= 32 &&
        /^[1-9]\d{0,19}$/.test(integrationOwner) && timingSafeEqual(
          createHash('sha256').update(String(req.headers['x-emailbot-key'] || '')).digest(),
          createHash('sha256').update(integrationKey).digest());
      if (integrationRequest && !serviceAuthorized()) return reply(res, 403, { error: 'Integration access denied' });
      if (req.method === 'GET' && url.pathname === '/api/emailbot/capabilities') {
        if (!serviceAuthorized()) return reply(res, 403, { error: 'Integration access denied' });
        return reply(res, 200, { version: 1, confirmedCredentials: true, requestRecovery: true });
      }
      const requestLookup = url.pathname.match(/^\/api\/emailbot\/requests\/([a-zA-Z0-9_-]{16,80})$/);
      if (requestLookup) {
        if (!serviceAuthorized()) return reply(res, 403, { error: 'Integration access denied' });
        const run = [...runs.values()].find(r => r.emailbotRequestId === requestLookup[1] && r.emailbotOwner === integrationOwner);
        if (!run || req.method !== 'GET') return reply(res, 404, { error: 'Run not found' });
        return reply(res, 200, run);
      }
      const resultMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)\/result$/);
      if (resultMatch) {
        if (!serviceAuthorized()) return reply(res, 403, { error: 'Integration access denied' });
        const run = runs.get(resultMatch[1]);
        if (!run || run.emailbotOwner !== integrationOwner || req.method !== 'GET') return reply(res, 404, { error: 'Run not found' });
        if (run.status !== 'succeeded' || run.flowId !== 'inbox' || run.inspect) return reply(res, 409, { error: 'Registration not confirmed' });
        const filename = path.join(dataDir, run.id, 'inbox-credentials.json');
        let credentials;
        try {
          const stat = fs.lstatSync(filename);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw Error('Invalid result');
          credentials = JSON.parse(fs.readFileSync(filename, 'utf8'));
        } catch { return reply(res, 409, { error: 'Registration not confirmed' }); }
        if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) || typeof run.variables?.INBOX_USERNAME !== 'string') return reply(res, 409, { error: 'Registration not confirmed' });
        const expected = `${run.variables.INBOX_USERNAME.toLowerCase()}@inbox.eu`;
        if (credentials.status !== 'registered' || credentials.email !== expected || typeof credentials.password !== 'string' || !credentials.password || credentials.password.length > 1024) return reply(res, 409, { error: 'Registration not confirmed' });
        return reply(res, 200, { status: 'registered', inspect: false, email: credentials.email,
          password: credentials.password,
          ...(typeof credentials.imapPassword === 'string' && credentials.imapPassword ? { imapPassword: credentials.imapPassword } : {}) });
      }
      const registry = readRegistry();
      if (req.method === 'GET' && url.pathname === '/api/flows') return reply(res, 200, registry.map(publicFlow));
      if (req.method === 'GET' && url.pathname === '/api/runs') return reply(res, 200, [...runs.values()].filter(r => !integrationRequest || r.emailbotOwner === integrationOwner).sort((a,b) => b.startedAt.localeCompare(a.startedAt)));
      const match = url.pathname.match(/^\/api\/runs\/([\w-]+)(\/cancel)?$/);
      if (match) {
        const run = runs.get(match[1]);
        if (!run || (integrationRequest && run.emailbotOwner !== integrationOwner)) return reply(res, 404, { error: 'Run not found' });
        if (req.method === 'GET' && !match[2]) return reply(res, 200, run);
        if (req.method === 'POST' && match[2]) {
          if (children.has(run.id)) { run.status = 'cancelled'; children.get(run.id).kill(); persist(run); }
          return reply(res, 200, run);
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/runs') {
        if (!req.headers['content-type']?.startsWith('application/json')) return reply(res, 415, { error: 'Use application/json' });
        let body = '';
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 16384) return reply(res, 413, { error: 'Request too large' }); }
        let input;
        try { input = JSON.parse(body); } catch { return reply(res, 400, { error: 'Invalid JSON' }); }
        const flow = registry.find(flow => flow.id === input.flowId);
        if (!flow) return reply(res, 400, { error: 'Unknown flow' });
        const requestId = String(req.headers['x-emailbot-request'] || '');
        if (integrationRequest) {
          if (input.flowId !== 'inbox' || input.inspect !== false || !/^[a-zA-Z0-9_-]{16,80}$/.test(requestId)) return reply(res, 400, { error: 'Invalid integration request' });
          const prior = [...runs.values()].find(r => r.emailbotOwner === integrationOwner && r.emailbotRequestId === requestId);
          if (prior) {
            if (prior.variables.INBOX_USERNAME !== input.variables?.INBOX_USERNAME) return reply(res, 409, { error: 'Request already used' });
            return reply(res, 202, prior);
          }
        }
        if (children.size >= 3) return reply(res, 409, { error: 'Three flows are already running' });
        if (!input.variables || typeof input.variables !== 'object' || Array.isArray(input.variables)) return reply(res, 400, { error: 'variables must be an object' });
        const env = { ...process.env };
        delete env.EMAILBOT_INTEGRATION_KEY;
        const variables = {};
        const secrets = [process.env.BROWSERLESS_TOKEN].filter(Boolean);
        for (const key of Object.keys(input.variables)) if (!flow.fields.some(f => f.name === key)) return reply(res, 400, { error: `Unknown variable: ${key}` });
        for (const field of flow.fields) {
          const value = input.variables[field.name] ?? '';
          if (typeof value !== 'string' || value.length > 1024 || (field.required && !value.trim()) || (value && field.pattern && !new RegExp(field.pattern).test(value))) return reply(res, 400, { error: `Invalid ${field.label}` });
          delete env[field.name];
          if (value) env[field.name] = value;
          if (field.secret && value) secrets.push(value);
          if (!field.secret) variables[field.name] = value;
        }
        if (input.inspect !== undefined && typeof input.inspect !== 'boolean') return reply(res, 400, { error: 'inspect must be boolean' });
        if (input.inspect && !flow.supportsInspect) return reply(res, 400, { error: 'Flow does not support inspection' });
        const id = randomUUID();
        const outputDir = path.join(dataDir, id);
        fs.mkdirSync(outputDir);
        env.FLOW_OUTPUT_DIR = outputDir;
        const run = { id, flowId: flow.id, flowName: flow.name, variables, inspect: !!input.inspect, status: 'running', startedAt: new Date().toISOString(), logs: '' };
        if (integrationRequest) { run.emailbotOwner = integrationOwner; run.emailbotRequestId = requestId; }
        runs.set(id, run); persist(run);
        const child = spawn(process.execPath, [path.join(root, 'flows', flow.script), ...(input.inspect ? ['--inspect'] : [])], { cwd: root, env, windowsHide: true, shell: false });
        children.set(id, child);
        const append = chunk => { let text = chunk.toString(); for (const secret of secrets) text = text.split(secret).join('[REDACTED]'); run.logs = (run.logs + text).slice(-100000); persist(run); };
        child.stdout.on('data', append); child.stderr.on('data', append);
        const timer = setTimeout(() => { run.status = 'timed_out'; child.kill(); }, timeoutMs);
        child.on('error', error => append(`Runner error: ${error.message}\n`));
        child.on('close', code => { clearTimeout(timer); children.delete(id); if (run.status === 'running') run.status = code === 0 ? 'succeeded' : 'failed'; run.exitCode = code; run.finishedAt = new Date().toISOString(); persist(run); });
        return reply(res, 202, run);
      }
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (req.method === 'GET' && assets[url.pathname]) {
        const [name, type] = assets[url.pathname];
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; img-src 'self' https://www.google.com https://*.gstatic.com; style-src 'self'; script-src 'self'; frame-ancestors 'none'" });
        return res.end(fs.readFileSync(path.join(root, 'public', name)));
      }
      reply(res, 404, { error: 'Not found' });
    } catch (error) { console.error(error.message); if (!res.headersSent) reply(res, 500, { error: 'Internal server error' }); else res.end(); }
  });
  return { server, stop: () => { for (const child of children.values()) child.kill(); server.close(); } };
}
if (require.main === module) {
  if (fs.existsSync(path.join(__dirname, '.env'))) process.loadEnvFile(path.join(__dirname, '.env'));
  const app = createApp();
  const host = process.env.HOST || '127.0.0.1';
  app.server.listen(Number(process.env.PORT || 3000), host, () => console.log(`Flow Runner: ${process.env.APP_ORIGIN || `http://${host}:${app.server.address().port}`}`));
  process.on('SIGINT', app.stop); process.on('SIGTERM', app.stop);
}
module.exports = { createApp };

