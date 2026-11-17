# autoweb

A self-building website. Open it and you see an empty page with a single prompt
bar at the bottom. Type what you want — the AI agent rewrites the site, commits
the result to this GitHub repo, and the page updates live.

## Run it

```sh
git clone https://github.com/AdBuch/autoweb.git && cd autoweb   # must be a clone: pushes go via git
cp .env.example .env   # then fill in one provider API key
node server.js         # or: npm start
```

Open http://127.0.0.1:4173 — that's the whole UI: an empty canvas with a prompt
bot at the bottom.

No dependencies; Node.js >= 20 only.

## How a prompt flows

1. The shell (`public/shell.html`) renders the current site from `site/` in a
   full-page iframe, with the prompt bar fixed at the bottom.
2. `POST /api/prompt` sends the prompt plus the current site files to the agent
   (`agent.js`).
3. The agent answers with JSON: `{ summary, files: { path: content }, delete: [...] }`.
4. `server.js` writes the files into `site/`, then `github.js` commits them with
   git and pushes to this repo (`site/` on the target branch, one commit per prompt).
5. The shell reloads the iframe — the website has adapted.

Prompt history and the last commit are kept in `state.json` (gitignored) and
shown in the status line above the prompt bar.

## AI providers

Set `PROVIDER` or just drop in one key — the first key found wins:

| Provider | Env key | Model env | Default model |
|---|---|---|---|
| Mistral | `MISTRAL_API_KEY` | `MISTRAL_MODEL` | `mistral-large-latest` |
| OpenAI / ChatGPT | `OPENAI_API_KEY` | `OPENAI_MODEL` | `gpt-4o` |
| Anthropic / Claude | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` | `claude-sonnet-4-5` |
| Gemini | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | `GEMINI_MODEL` | `gemini-2.5-flash` |
| Ollama (local) | none | `OLLAMA_MODEL`, `OLLAMA_HOST` | `llama3.2` at `http://127.0.0.1:11434` |

Aliases `chatgpt`, `claude`, `gemeni`, `gpt` are accepted for `PROVIDER`.
With no key at all the app runs in **mock mode**: a deterministic placeholder
page is generated so the full pipeline (prompt → site → GitHub commit) still
works end to end.

## GitHub connection

The app runs inside a git clone of this repo and uses plain `git push`, so any
working credential setup is fine (`gh auth login`, stored HTTPS credentials, SSH…).

- `GITHUB_REPO` — optional; defaults to the `origin` remote (used for commit links).
- `SITE_BRANCH` — branch the generated site is pushed to; defaults to the repo's
  default branch.
- `GITHUB_PUSH=false` — update `site/` locally without pushing (useful for tests).

Each prompt creates one commit under `site/`; the status bar links to it.

## Configuration

See [.env.example](.env.example). `PORT` (default 4173) and `HOST` (default
`127.0.0.1`) control the server. The server binds to loopback only by default —
do not expose it publicly without adding authentication.

## Layout

```
server.js          zero-dependency HTTP server (shell, /site/*, /api/*)
agent.js           multi-provider AI agent client (mistral/openai/anthropic/gemini/ollama/mock)
github.js          commits and pushes site/ via git
public/shell.html  the empty page + bottom prompt bar
site/              the generated website (starts empty)
state.json         runtime history (gitignored)
```
