// Lines that match one of the user's patterns (phone numbers, email addresses, pay figures) never leave the Mac.
// The patterns come from aside.config.json ({"redact": ["regex", ...]}); see aside.config.example.json.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadRedactions(root) {
  const file = join(root, 'aside.config.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).redact || []).map((p) => new RegExp(p, 'i')) : [];
}

export const redact = (text, patterns) => text.split('\n').filter((l) => !patterns.some((re) => re.test(l))).join('\n');
