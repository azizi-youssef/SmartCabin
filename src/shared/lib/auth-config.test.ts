// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * SC-AUD-01 configuration guard: Supabase Auth itself must refuse SMS abuse, because its API is
 * reachable directly with the public key (the app's checks alone are not enough). This fails if
 * someone loosens these settings in supabase/config.toml. The hosted project's dashboard must
 * mirror them (docs/SECURITY_MODEL.md §7).
 */

function section(toml: string, name: string): Record<string, string> {
  const lines = toml.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `[${name}]`);
  if (start < 0) return {};
  const values: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) break;
    const m = /^([a-z_]+)\s*=\s*(.+)$/.exec(trimmed);
    if (m?.[1] && m[2]) values[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return values;
}

const toml = readFileSync(join(process.cwd(), 'supabase', 'config.toml'), 'utf8');

describe('Supabase Auth settings (SC-AUD-01)', () => {
  it('requires a Turnstile CAPTCHA, with the secret read from the environment', () => {
    expect(section(toml, 'auth.captcha')).toEqual({ enabled: 'true', provider: 'turnstile', secret: 'env(SUPABASE_AUTH_CAPTCHA_SECRET)' });
  });

  it('creates phone accounts only through the Moroccan-mobile hook, and limits SMS per number and per hour', () => {
    const sms = section(toml, 'auth.sms');
    // Phone sign-ups (online booking, S7) are allowed, so the hook that filters them must be on.
    expect(section(toml, 'auth.hook.before_user_created')).toEqual({ enabled: 'true', uri: 'pg-functions://postgres/public/before_user_created' });
    expect(['true', 'false']).toContain(sms['enable_signup']);
    expect(Number.parseInt(sms['max_frequency'] ?? '0', 10)).toBeGreaterThanOrEqual(60);
    expect(Number(section(toml, 'auth.rate_limit')['sms_sent'])).toBeLessThanOrEqual(30);
  });
});
