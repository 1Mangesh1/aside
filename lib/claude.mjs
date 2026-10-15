// Two ways to reach Claude behind one interface:
//   api: the Anthropic API with the key from the Keychain entry "anthropic-api" (prompt caching, real cost);
//   cli: Claude Code headless (`claude -p`) on the user's own subscription.
// "auto" uses the API until it reports an empty credit balance, then Claude Code for the rest of the process.
// Every call is one prompt with the whole transcript, so a meeting can switch backends between questions.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { userInfo, tmpdir } from 'node:os';
import Anthropic from '@anthropic-ai/sdk';

export const MODEL = 'claude-opus-5-5';
// Claude Opus 5.5 list prices in USD per million tokens; cache writes are 1.25x (5 minutes) and 2x (1 hour) of input.
const PRICE = { input: 4, output: 20, cacheRead: 0.2, write5m: 5, write1h: 8 };

export function costUsd(u) {
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5m = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : (u.cache_creation_input_tokens ?? 0);
  return ((u.input_tokens ?? 0) * PRICE.input + w5m * PRICE.write5m + w1h * PRICE.write1h
    + (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead + (u.output_tokens ?? 0) * PRICE.output) / 1e6;
}

const textOf = (msg) => msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');

function keychainKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try { return execFileSync('security', ['find-generic-password', '-a', userInfo().username, '-s', 'anthropic-api', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

export function makeClaude({ root }) {
  const key = keychainKey();
  const api = key ? new Anthropic({ apiKey: key }) : null;
  const state = { apiExhausted: false };
  // A private config folder keeps the user's CLAUDE.md, hooks, plugins and memory out of headless sessions.
  // It needs one interactive login: CLAUDE_CONFIG_DIR=<root>/.claude-headless claude, then /login.
  const cliHome = join(root, '.claude-headless');
  const promptDir = join(tmpdir(), 'aside-prompts');
  mkdirSync(promptDir, { recursive: true });

  const status = () => ({ api: !!api && !state.apiExhausted, cli: true, cliIsolated: existsSync(cliHome) });
  const pick = (kind) => (kind === 'api' || (kind === 'auto' && api && !state.apiExhausted) ? 'api' : 'cli');
  const isCreditError = (e) => e instanceof Anthropic.BadRequestError && /credit balance/i.test(e.message);

  // Streams so that a long transcript cannot hit a request timeout; onText receives each piece of the answer.
  async function viaApi({ system, prompt, effort, onText }) {
    const stream = api.beta.messages.stream({
      model: MODEL, max_tokens: 16000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      output_config: { effort },
      cache_control: { type: 'ephemeral' },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: prompt }],
    });
    if (onText) stream.on('text', (delta) => onText(delta));
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error('The request was declined.');
    return { text: textOf(msg), cost: costUsd(msg.usage), backend: 'api' };
  }

  function viaCli({ system, prompt, effort }) {
    // The system prompt goes in a file named by its hash.
    const file = join(promptDir, createHash('sha256').update(system).digest('hex').slice(0, 16) + '.txt');
    if (!existsSync(file)) writeFileSync(file, system);
    const args = ['-p', '--setting-sources', 'project', '--tools', '', '--strict-mcp-config', '--no-session-persistence',
      '--model', 'opus', '--effort', effort, '--system-prompt-file', file, '--output-format', 'json'];
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // headless runs on the subscription login, never the API key
    if (existsSync(cliHome)) env.CLAUDE_CONFIG_DIR = cliHome;
    return new Promise((resolve, reject) => {
      const child = spawn('claude', args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', reject);
      child.stdin.on('error', reject); // claude can exit before it reads a long prompt; unhandled, that EPIPE kills the server
      child.on('close', (code) => {
        let events;
        try { events = JSON.parse(out); } catch { return reject(new Error((out || err).trim().slice(0, 300) || `claude exited with ${code}`)); }
        const r = [].concat(events).find((e) => e.type === 'result');
        if (!r || r.is_error) return reject(new Error(r?.result || 'Claude Code returned no result.'));
        resolve({ text: r.result, cost: 0, backend: 'cli' });
      });
      child.stdin.end(prompt);
    });
  }

  // One entry point for every caller: a system prompt and one user prompt.
  async function ask(kind, { system, prompt, effort = 'medium', onText }) {
    if (pick(kind) === 'api') {
      try { return await viaApi({ system, prompt, effort, onText }); }
      catch (e) { if (!isCreditError(e) || kind !== 'auto') throw e; state.apiExhausted = true; console.log('API credit is used up. Continuing on Claude Code.'); }
    }
    // ponytail: Claude Code answers arrive whole. Its stream-json output can stream them if the wait matters.
    const r = await viaCli({ system, prompt, effort });
    onText?.(r.text);
    return r;
  }

  return { ask, status };
}
