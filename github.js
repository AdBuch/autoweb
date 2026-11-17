import { execFileSync } from 'node:child_process';

function git(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
  }).trim();
}

function gitSafe(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

export function resolveRepo(env = process.env, cwd) {
  if (env.GITHUB_REPO) return env.GITHUB_REPO.replace(/\.git$/, '').replace(/\/+$/, '');
  try {
    const url = git(cwd, ['remote', 'get-url', 'origin']);
    const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
    if (m) return `${m[1]}/${m[2]}`;
  } catch {}
  return null;
}

function defaultBranch(cwd) {
  const sym = gitSafe(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (sym) return sym.replace(/^origin\//, '');
  const current = gitSafe(cwd, ['branch', '--show-current']);
  return current || 'main';
}

export async function pushSiteFiles({ changed = [], message, siteDir = 'site', cwd, env = process.env }) {
  if (env.GITHUB_PUSH === 'false') return { pushed: false, reason: 'GITHUB_PUSH=false' };
  const remote = gitSafe(cwd, ['remote', 'get-url', 'origin']);
  if (!remote) return { pushed: false, reason: 'no git remote "origin" (run the app inside a clone of the repo)' };
  const repo = resolveRepo(env, cwd);
  const branch = env.SITE_BRANCH || defaultBranch(cwd);

  git(cwd, ['add', '-A', '--', siteDir]);
  let commitSha;
  try {
    git(cwd, ['commit', '-m', message]);
    commitSha = git(cwd, ['rev-parse', 'HEAD']);
  } catch (err) {
    const out = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
    if (out.includes('nothing to commit') || out.includes('nothing added to commit')) {
      commitSha = git(cwd, ['rev-parse', 'HEAD']);
    } else {
      return { pushed: false, reason: `git commit failed: ${out.slice(0, 200)}` };
    }
  }

  try {
    git(cwd, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
  } catch (err) {
    const out = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
    return { pushed: false, reason: `git push failed: ${out.slice(0, 300)}`, commitSha, branch };
  }

  return {
    pushed: true,
    repo,
    branch,
    commitSha,
    commitUrl: repo && commitSha ? `https://github.com/${repo}/commit/${commitSha}` : null,
    changed,
  };
}
