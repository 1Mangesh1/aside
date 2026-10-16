// Settings shared by the server and the menu-bar app, in prefs.json next to the code. A hot key needs two different
// modifiers, one of them Command or Control: macOS refuses global hot keys that use only Shift and Option, and a global
// Command+C would take Copy from every app.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { writeJson } from './meeting.mjs';

export const DEFAULTS = {
  hotkeyOpen: 'opt+cmd+a',
  hotkeyAsk: 'opt+cmd+k',
  detect: true,
  detectApps: ['us.zoom.xos', 'com.microsoft.teams2', 'com.microsoft.teams', 'com.tinyspeck.slackmacgap', 'com.cisco.webexmeetingsapp', 'com.apple.FaceTime',
    'com.google.Chrome', 'company.thebrowser.Browser', 'com.apple.Safari', 'com.brave.Browser', 'org.mozilla.firefox', 'com.microsoft.edgemac'],
  backend: 'auto',
  keepAudio: false,
  meetingsDir: '',
};

const HOTKEY = /^(?=(?:.*\+)?(?:cmd|ctrl)\+)(?!.*\b(cmd|ctrl|opt|shift)\+.*\b\1\+)(?:(?:cmd|ctrl|opt|shift)\+){2,4}[a-z0-9]$/;
const CHECKS = {
  hotkeyOpen: (v) => typeof v === 'string' && HOTKEY.test(v),
  hotkeyAsk: (v) => typeof v === 'string' && HOTKEY.test(v),
  detect: (v) => typeof v === 'boolean',
  detectApps: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && /^[\w.-]+$/.test(x)),
  backend: (v) => ['auto', 'api', 'cli'].includes(v),
  keepAudio: (v) => typeof v === 'boolean',
  meetingsDir: (v) => v === '' || (typeof v === 'string' && /^(\/|~\/)/.test(v)),
};
const fail = (message) => Object.assign(new Error(message), { code: 400 });

export function loadPrefs(root) {
  const file = join(root, 'prefs.json');
  return { ...DEFAULTS, ...(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}) };
}

export function savePrefs(root, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw fail('Send the settings as an object.');
  for (const [k, v] of Object.entries(patch)) {
    if (!CHECKS[k]) throw fail(`Unknown setting: ${k}`);
    if (!CHECKS[k](v)) throw fail(`Not a valid value for ${k}.`);
  }
  const next = { ...loadPrefs(root), ...patch };
  if (next.hotkeyOpen === next.hotkeyAsk) throw fail('The two hot keys must be different.');
  writeJson(join(root, 'prefs.json'), next);
  return next;
}

export const meetingsBase = (root, prefs) => (prefs.meetingsDir ? prefs.meetingsDir.replace(/^~(?=\/)/, homedir()) : join(root, 'meetings'));
