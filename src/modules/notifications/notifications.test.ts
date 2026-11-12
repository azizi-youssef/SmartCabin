import { describe, expect, it, vi } from 'vitest';

import { runDispatch, type RpcCall } from './dispatch';
import { signJob, verifyJobSignature } from './hmac';
import { disabledProvider, providerFromEnv, sendWithTimeout, simulatorProvider, type MessageProvider } from './providers';

const SECRET = 'test-secret-'.padEnd(48, 's');
const NOW = new Date('2026-11-11T10:00:00Z');
const TS = String(Math.floor(NOW.getTime() / 1000));

describe('job signature', () => {
  it('accepts a fresh, correctly signed call', () => {
    const signature = signJob(SECRET, TS, '{}');
    expect(verifyJobSignature({ secret: SECRET, timestamp: TS, signature, body: '{}', now: NOW })).toBe(true);
  });

  it('is hex HMAC-SHA256 of "<ts>.<body>"', () => {
    // Reference: printf '1700000000.{}' | openssl dgst -sha256 -hmac 'Jefe'
    // (the SQL side is cross-checked in tests/db/notifications.test.ts).
    expect(signJob('Jefe', '1700000000', '{}')).toBe('d3793e2b4103edfbd98cc19591832f5fad701d413db9fcae0ae7dab8184ed207');
  });

  it('rejects a tampered body, a wrong secret, a stale or future timestamp, and malformed headers', () => {
    const signature = signJob(SECRET, TS, '{}');
    const base = { secret: SECRET, timestamp: TS, signature, body: '{}', now: NOW };
    expect(verifyJobSignature({ ...base, body: '{"limit":999}' })).toBe(false);
    expect(verifyJobSignature({ ...base, secret: 'other-secret-'.padEnd(48, 'o') })).toBe(false);
    expect(verifyJobSignature({ ...base, now: new Date(NOW.getTime() + 301_000) })).toBe(false);
    expect(verifyJobSignature({ ...base, now: new Date(NOW.getTime() - 301_000) })).toBe(false);
    expect(verifyJobSignature({ ...base, now: new Date(NOW.getTime() + 299_000) })).toBe(true);
    expect(verifyJobSignature({ ...base, timestamp: null })).toBe(false);
    expect(verifyJobSignature({ ...base, signature: null })).toBe(false);
    expect(verifyJobSignature({ ...base, signature: signature.toUpperCase() })).toBe(false);
    expect(verifyJobSignature({ ...base, signature: signature.slice(2) })).toBe(false);
    expect(verifyJobSignature({ ...base, timestamp: `${TS}.5` })).toBe(false);
  });

  it('refuses every call when the secret is missing or too short', () => {
    expect(verifyJobSignature({ secret: '', timestamp: TS, signature: signJob('', TS, '{}'), body: '{}', now: NOW })).toBe(false);
    const short = 'short-secret';
    expect(verifyJobSignature({ secret: short, timestamp: TS, signature: signJob(short, TS, '{}'), body: '{}', now: NOW })).toBe(false);
  });
});

describe('providers', () => {
  const message = { channel: 'sms' as const, to: '+999100000011', sender: 'Cabinet', subject: null, body: 'Rappel' };

  it('defaults to disabled; only "simulator" enables the simulator', () => {
    expect(providerFromEnv(undefined)).toBe(disabledProvider);
    expect(providerFromEnv('')).toBe(disabledProvider);
    expect(providerFromEnv('twilio')).toBe(disabledProvider);
    expect(providerFromEnv('simulator')).toBe(simulatorProvider);
  });

  it('the simulator accepts every message with a provider id', async () => {
    const result = await simulatorProvider.send(message);
    expect(result.outcome).toBe('accepted');
    expect(result.providerMessageId).toMatch(/^sim-/);
  });

  it('turns a hanging provider into a retryable timeout, and a throwing one into a retryable error', async () => {
    vi.useFakeTimers();
    try {
      const hanging: MessageProvider = { name: 'hang', enabled: true, send: () => new Promise(() => undefined) };
      const pending = sendWithTimeout(hanging, message, 1000);
      await vi.advanceTimersByTimeAsync(1001);
      await expect(pending).resolves.toEqual({ outcome: 'timeout', errorCode: 'TIMEOUT', retryable: true });
    } finally {
      vi.useRealTimers();
    }
    const throwing: MessageProvider = { name: 'boom', enabled: true, send: () => Promise.reject(new Error('down')) };
    await expect(sendWithTimeout(throwing, message)).resolves.toEqual({ outcome: 'error', errorCode: 'PROVIDER_EXCEPTION', retryable: true });
  });
});

describe('worker run', () => {
  const claimed = [
    { notification_id: '0b7c6b1e-3d1f-4c39-9c55-1a1a1a1a1a01', channel: 'sms', recipient: '+999100000011', sender: 'Cabinet', subject: null, body: 'A', attempt_no: 1 },
    { notification_id: '0b7c6b1e-3d1f-4c39-9c55-1a1a1a1a1a02', channel: 'email', recipient: 'p@x.test', sender: 'Cabinet', subject: 'S', body: 'B', attempt_no: 1 },
  ];

  function fakeRpc(statuses: string[]) {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    let recorded = 0;
    const rpc: RpcCall = async (fn, args) => {
      calls.push({ fn, args });
      if (fn === 'jobs_plan_notifications') return { data: 3, error: null };
      if (fn === 'jobs_claim_notifications') return { data: claimed, error: null };
      return { data: statuses[recorded++] ?? 'scheduled', error: null };
    };
    return { rpc, calls };
  }

  it('plans, claims, sends and records each answer, returning counts only', async () => {
    const { rpc, calls } = fakeRpc(['sent', 'scheduled']);
    const provider: MessageProvider = {
      name: 'test',
      enabled: true,
      send: vi.fn()
        .mockResolvedValueOnce({ outcome: 'accepted', providerMessageId: 'm-1', retryable: false })
        .mockResolvedValueOnce({ outcome: 'error', errorCode: 'RATE_LIMIT', retryable: true }),
    };
    const summary = await runDispatch({ rpc, jobKey: SECRET, provider });
    expect(summary).toEqual({ planned: 3, claimed: 2, sent: 1, failed: 0, retrying: 1 });
    expect(calls.map((c) => c.fn)).toEqual(['jobs_plan_notifications', 'jobs_claim_notifications', 'jobs_record_attempt', 'jobs_record_attempt']);
    expect(calls.every((c) => c.args['p_job_key'] === SECRET)).toBe(true);
    expect(calls[2]?.args).toMatchObject({ p_outcome: 'accepted', p_provider: 'test', p_provider_message_id: 'm-1', p_retryable: false });
    expect(calls[3]?.args).toMatchObject({ p_outcome: 'error', p_error_code: 'RATE_LIMIT', p_retryable: true });
    expect(JSON.stringify(summary)).not.toContain('+999');
  });

  it('with the disabled provider, plans but claims nothing (messages stay scheduled)', async () => {
    const { rpc, calls } = fakeRpc([]);
    const summary = await runDispatch({ rpc, jobKey: SECRET, provider: disabledProvider });
    expect(summary).toEqual({ planned: 3, claimed: 0, sent: 0, failed: 0, retrying: 0 });
    expect(calls.map((c) => c.fn)).toEqual(['jobs_plan_notifications']);
  });

  it('stops on a planning or claim error (the next scheduled run retries)', async () => {
    const failing: RpcCall = async () => ({ data: null, error: { message: 'FORBIDDEN' } });
    await expect(runDispatch({ rpc: failing, jobKey: SECRET, provider: simulatorProvider })).rejects.toThrow('plan failed');
  });
});
