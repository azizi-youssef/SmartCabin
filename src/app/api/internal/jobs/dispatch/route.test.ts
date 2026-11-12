// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { signJob } from '@/modules/notifications/hmac';

const rpc = vi.fn();
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc }) }));

const SECRET = 'route-secret-'.padEnd(48, 'r');

function request(body: string, headers: Record<string, string>) {
  return new NextRequest('http://localhost/api/internal/jobs/dispatch', { method: 'POST', body, headers });
}

function signed(body = '{}', ts = String(Math.floor(Date.now() / 1000))) {
  return { 'x-smartcabin-timestamp': ts, 'x-smartcabin-signature': signJob(SECRET, ts, body) };
}

describe('POST /api/internal/jobs/dispatch', () => {
  beforeEach(() => {
    vi.stubEnv('JOBS_SECRET', SECRET);
    vi.stubEnv('NOTIFICATIONS_PROVIDER', 'simulator');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test_key_000');
    rpc.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('refuses unsigned, wrongly signed and stale calls without touching the database', async () => {
    const { POST } = await import('./route');
    const stale = String(Math.floor(Date.now() / 1000) - 600);
    for (const headers of [{}, { ...signed(), 'x-smartcabin-signature': 'f'.repeat(64) }, signed('{}', stale)]) {
      const res = await POST(request('{}', headers));
      expect(res.status).toBe(401);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refuses every call when JOBS_SECRET is not configured', async () => {
    vi.stubEnv('JOBS_SECRET', '');
    const { POST } = await import('./route');
    expect((await POST(request('{}', signed()))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refuses a body over 1 KB', async () => {
    const { POST } = await import('./route');
    const body = JSON.stringify({ pad: 'x'.repeat(2000) });
    expect((await POST(request(body, signed(body)))).status).toBe(413);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('runs one dispatch for a valid call and answers counts only', async () => {
    rpc.mockImplementation(async (fn: string) => {
      if (fn === 'jobs_plan_notifications') return { data: 1, error: null };
      if (fn === 'jobs_claim_notifications') {
        return { data: [{ notification_id: '0b7c6b1e-3d1f-4c39-9c55-1a1a1a1a1a01', channel: 'sms', recipient: '+999100000011', sender: 'Cabinet', subject: null, body: 'Rappel', attempt_no: 1 }], error: null };
      }
      return { data: 'sent', error: null };
    });
    const { POST } = await import('./route');
    const res = await POST(request('{}', signed()));
    expect(res.status).toBe(200);
    const json: unknown = await res.json();
    expect(json).toEqual({ planned: 1, claimed: 1, sent: 1, failed: 0, retrying: 0 });
    expect(JSON.stringify(json)).not.toContain('+999');
    expect(rpc.mock.calls.every(([, args]) => (args as Record<string, unknown>)['p_job_key'] === SECRET)).toBe(true);
  });

  it('answers 503 with no detail when the database refuses', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'FORBIDDEN' } });
    const { POST } = await import('./route');
    const res = await POST(request('{}', signed()));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'UNAVAILABLE' });
  });
});
