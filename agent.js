const ALIASES = {
  mistral: 'mistral',
  openai: 'openai',
  chatgpt: 'openai',
  gpt: 'openai',
  anthropic: 'anthropic',
  claude: 'anthropic',
  gemini: 'gemini',
  gemeni: 'gemini',
  google: 'gemini',
  ollama: 'ollama',
};

const MAX_FILES = 40;
const MAX_FILE_CHARS = 100_000;

const SYSTEM_PROMPT = [
  'You are Autoweb, an autonomous website-building agent.',
  'The user describes what they want; you produce the complete website as files.',
  'Respond with exactly one JSON object and nothing else:',
  '{"summary": "one short sentence describing what you built or changed", "files": {"<relative path>": "<full new file content>"}, "delete": ["<paths to remove>"]}',
  'Rules:',
  '- "files" values are FULL file contents, not diffs; include only files you create or change.',
  '- Put files that should be removed under "delete"; omit the key when nothing is removed.',
  '- Paths are relative to the site root (index.html, styles.css, app.js, assets/...); never absolute, never containing "..".',
  '- index.html must be a complete, valid HTML5 document.',
  '- Prefer self-contained vanilla HTML/CSS/JS with no build step and no external services unless the user asks for them.',
  '- Keep existing content and styling the user did not ask to change.',
  '- If the request is unclear, make a sensible choice and mention it in "summary".',
].join('\n');

export function resolveProvider(env = process.env) {
  const raw = (env.PROVIDER || '').toLowerCase().trim();
  const alias = ALIASES[raw] || raw || null;
  const keys = {
    mistral: env.MISTRAL_API_KEY || null,
    openai: env.OPENAI_API_KEY || null,
    anthropic: env.ANTHROPIC_API_KEY || null,
    gemini: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || null,
  };
  const ollamaWanted = alias === 'ollama' || !!env.OLLAMA_MODEL || !!env.OLLAMA_HOST;
  let provider = alias;
  if (provider && provider !== 'ollama' && !keys[provider]) {
    return { provider: 'mock', model: null, apiKey: null, reason: `PROVIDER=${provider} is set but its API key is missing` };
  }
  if (!provider) {
    provider = ['mistral', 'openai', 'anthropic', 'gemini'].find((p) => keys[p]) || (ollamaWanted ? 'ollama' : null);
  }
  if (!provider) provider = 'mock';
  const models = {
    mistral: env.MISTRAL_MODEL || 'mistral-large-latest',
    openai: env.OPENAI_MODEL || 'gpt-4o',
    anthropic: env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
    gemini: env.GEMINI_MODEL || 'gemini-2.5-flash',
    ollama: env.OLLAMA_MODEL || 'llama3.2',
    mock: null,
  };
  return { provider, model: models[provider] || null, apiKey: keys[provider] || null };
}

function buildUserMessage(prompt, files) {
  const names = Object.keys(files || {});
  const listing = names.length
    ? names.map((p) => `=== ${p} ===\n${files[p]}`).join('\n\n')
    : '(the site is currently empty)';
  return `User prompt:\n"""\n${prompt}\n"""\n\nCurrent website files (path -> content):\n${listing}`;
}

async function callMistral(cfg, system, user) {
  const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`mistral API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

async function callOpenai(cfg, system, user) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`openai API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

async function callAnthropic(cfg, system, user) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 16384,
      temperature: 0.2,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

async function callGemini(cfg, system, user) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `${system}\n\n${user}` }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
    }),
  });
  if (!res.ok) throw new Error(`gemini API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

async function callOllama(cfg, system, user, env = process.env) {
  const host = (env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      stream: false,
      format: 'json',
      options: { temperature: 0.2 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`ollama API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.message?.content ?? '';
}

const PROVIDERS = {
  mistral: callMistral,
  openai: callOpenai,
  anthropic: callAnthropic,
  gemini: callGemini,
  ollama: callOllama,
};

function sanitizePath(p) {
  if (typeof p !== 'string') return null;
  const norm = p.replace(/\\/g, '/').trim();
  if (!norm || norm.startsWith('/') || norm.includes('\0')) return null;
  const segs = norm.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return null;
  return norm;
}

function parseAgentJson(text, prompt) {
  let cleaned = String(text || '').trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) cleaned = fence[1].trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('agent did not return a JSON object');
  let parsed;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch (err) {
    throw new Error(`agent returned invalid JSON: ${err.message}`);
  }
  const files = {};
  const rawFiles = parsed.files && typeof parsed.files === 'object' ? parsed.files : null;
  if (!rawFiles) throw new Error('agent JSON has no "files" object');
  const entries = Object.entries(rawFiles);
  if (entries.length > MAX_FILES) throw new Error(`agent returned too many files (max ${MAX_FILES})`);
  for (const [p, content] of entries) {
    const safe = sanitizePath(p);
    if (!safe) throw new Error(`agent returned an unsafe path: ${p}`);
    const str = String(content ?? '');
    if (str.length > MAX_FILE_CHARS) throw new Error(`agent file too large: ${p}`);
    files[safe] = str;
  }
  if (!files['index.html']) throw new Error('agent must always provide index.html');
  const del = Array.isArray(parsed.delete) ? parsed.delete : [];
  const deletes = [];
  for (const p of del.slice(0, MAX_FILES)) {
    const safe = sanitizePath(p);
    if (safe && safe !== 'index.html') deletes.push(safe);
  }
  return { summary: String(parsed.summary || '').slice(0, 300) || 'updated the site', files, delete: deletes };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function mockAgent(prompt) {
  const title = escapeHtml(prompt.slice(0, 120));
  const files = {
    'index.html': `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="styles.css">
</head>
<body>
<main class="hero">
  <p class="kicker">autoweb · mock agent build</p>
  <h1>${title}</h1>
  <p class="sub">This placeholder was generated by the built-in mock agent because no LLM API key is configured. Set one in <code>.env</code> and prompt again to go live.</p>
</main>
</body>
</html>
`,
    'styles.css': `:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0e1117; color: #e8eaf0; font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
.hero { max-width: 720px; padding: 48px 24px; text-align: center; }
.kicker { text-transform: uppercase; letter-spacing: .18em; font-size: 12px; color: #6e8bff; }
h1 { font-size: clamp(28px, 5vw, 48px); line-height: 1.15; margin: 12px 0; }
.sub { color: #9aa0ae; }
code { background: rgba(255,255,255,.08); padding: 2px 6px; border-radius: 6px; }
`,
  };
  return { summary: `Mock agent built a placeholder page for: "${prompt.slice(0, 80)}"`, files, delete: [] };
}

export async function runAgent({ prompt, files }) {
  const cfg = resolveProvider();
  if (cfg.provider === 'mock') return mockAgent(prompt);
  const user = buildUserMessage(prompt, files);
  const text = await PROVIDERS[cfg.provider]({ ...cfg }, SYSTEM_PROMPT, user);
  return parseAgentJson(text, prompt);
}
