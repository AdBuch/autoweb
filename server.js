import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent, resolveProvider } from './agent.js';
import { pushSiteFiles, resolveRepo } from './github.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.join(ROOT, 'site');
const SHELL_FILE = path.join(ROOT, 'public', 'shell.html');
const STATE_FILE = path.join(ROOT, 'state.json');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 100_000;
const MAX_SITE_CONTEXT = 300_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
};

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { history: [] };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

function sanitizeRel(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  const norm = path.normalize(p).replace(/\\/g, '/');
  if (norm.startsWith('/') || norm.includes('\0')) return null;
  if (norm.split('/').some((s) => s === '..')) return null;
  return norm;
}

function safeSitePath(rel) {
  const safe = sanitizeRel(rel);
  if (!safe) return null;
  const dest = path.resolve(SITE_DIR, safe);
  if (dest !== path.resolve(SITE_DIR) && !dest.startsWith(path.resolve(SITE_DIR) + path.sep)) return null;
  return dest;
}

function readSiteFiles() {
  const files = {};
  let budget = MAX_SITE_CONTEXT;
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!e.isFile() || budget <= 0) continue;
      try {
        const content = fs.readFileSync(full, 'utf8');
        const rel = path.relative(SITE_DIR, full).replace(/\\/g, '/');
        files[rel] = content.slice(0, 50_000);
        budget -= content.length;
      } catch {}
    }
  };
  walk(SITE_DIR);
  return files;
}

function applySiteFiles(files, deletes) {
  for (const [rel, content] of Object.entries(files || {})) {
    const dest = safeSitePath(rel);
    if (!dest) throw new Error(`unsafe path from agent: ${rel}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, String(content));
  }
  for (const rel of deletes || []) {
    const dest = safeSitePath(rel);
    if (!dest) continue;
    try {
      fs.unlinkSync(dest);
    } catch {}
  }
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

let queue = Promise.resolve();

async function handlePrompt(prompt) {
  const started = Date.now();
  const before = readSiteFiles();
  const agent = await runAgent({ prompt, files: before });
  applySiteFiles(agent.files, agent.delete);
  const push = await pushSiteFiles({
    changed: [...Object.keys(agent.files || {}), ...(agent.delete || []).map((p) => `-${p}`)],
    message: `site: ${prompt.slice(0, 72)}`,
    siteDir: 'site',
    cwd: ROOT,
  });
  const cfg = resolveProvider();
  const entry = {
    at: new Date().toISOString(),
    prompt,
    summary: agent.summary,
    provider: cfg.provider,
    model: cfg.model,
    files: Object.keys(agent.files || {}),
    deletes: agent.delete || [],
    pushed: push.pushed,
    pushReason: push.reason || null,
    commitSha: push.commitSha || null,
    commitUrl: push.commitUrl || null,
    branch: push.branch || null,
    durationMs: Date.now() - started,
  };
  const state = loadState();
  state.history = state.history || [];
  state.history.push(entry);
  if (state.history.length > 50) state.history = state.history.slice(-50);
  saveState(state);
  return { ok: true, ...entry };
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(u.pathname);

    if (req.method === 'GET' && pathname === '/') return serveFile(res, SHELL_FILE);
    if (req.method === 'GET' && pathname === '/api/health') return sendJson(res, 200, { ok: true });

    if (req.method === 'GET' && pathname === '/api/status') {
      const cfg = resolveProvider();
      const state = loadState();
      return sendJson(res, 200, {
        ok: true,
        mode: cfg.provider === 'mock' ? 'mock' : 'live',
        provider: cfg.provider,
        model: cfg.model,
        reason: cfg.reason || null,
        repo: resolveRepo(process.env, ROOT),
        branch: process.env.SITE_BRANCH || null,
        history: (state.history || []).slice(-10).reverse(),
      });
    }

    if (pathname === '/site' || pathname.startsWith('/site/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      let rel = pathname.slice('/site'.length).replace(/^\/+/, '');
      if (!rel) rel = 'index.html';
      const dest = safeSitePath(rel);
      if (!dest) return sendJson(res, 400, { ok: false, error: 'bad path' });
      return serveFile(res, dest);
    }

    if (req.method === 'POST' && pathname === '/api/prompt') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
      }
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt) return sendJson(res, 400, { ok: false, error: 'prompt is required' });
      if (prompt.length > 4000) return sendJson(res, 400, { ok: false, error: 'prompt too long (max 4000 chars)' });
      const result = await (queue = queue
        .then(() => handlePrompt(prompt))
        .catch((err) => ({ ok: false, error: String((err && err.message) || err) })));
      return sendJson(res, result.ok ? 200 : 500, result);
    }

    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
  }
});

server.listen(PORT, HOST, () => {
  const cfg = resolveProvider();
  console.log(`autoweb listening on http://${HOST}:${PORT} (loopback only)`);
  console.log(`agent: ${cfg.provider}${cfg.model ? ` (${cfg.model})` : ''}${cfg.provider === 'mock' ? ' — no API key found, using mock mode' : ''}`);
  console.log(`github repo: ${resolveRepo(process.env, ROOT) || 'unknown'} | site dir: ${SITE_DIR}`);
});
