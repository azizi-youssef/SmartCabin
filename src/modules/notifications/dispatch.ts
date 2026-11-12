import { z } from 'zod';

import { sendWithTimeout, type MessageChannel, type MessageProvider } from './providers';

/*
 * One worker run (module 9): plan from the outbox, claim due messages under a lease, send them,
 * record each answer. Every rule (consent, stale state, retries) is in the database; this only
 * moves messages. It returns counts only: no recipient, no content, nothing personal is logged.
 */

export type RpcCall = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;

export interface DispatchSummary {
  planned: number;
  claimed: number;
  sent: number;
  failed: number;
  retrying: number;
}

const claimedRows = z.array(z.object({
  notification_id: z.uuid(),
  channel: z.enum(['sms', 'whatsapp', 'email', 'push']),
  recipient: z.string(),
  sender: z.string().nullable(),
  subject: z.string().nullable(),
  body: z.string(),
  attempt_no: z.number().int(),
}));

export async function runDispatch(input: { rpc: RpcCall; jobKey: string; provider: MessageProvider; limit?: number }): Promise<DispatchSummary> {
  const { rpc, jobKey, provider } = input;
  const summary: DispatchSummary = { planned: 0, claimed: 0, sent: 0, failed: 0, retrying: 0 };

  const planned = await rpc('jobs_plan_notifications', { p_job_key: jobKey, p_limit: 500 });
  if (planned.error) throw new Error(`plan failed: ${planned.error.message}`);
  summary.planned = typeof planned.data === 'number' ? planned.data : 0;
  // Without a provider, messages stay scheduled (nothing is claimed, nothing is lost).
  if (!provider.enabled) return summary;

  const claimed = await rpc('jobs_claim_notifications', { p_job_key: jobKey, p_limit: input.limit ?? 50, p_lease_seconds: 120 });
  if (claimed.error) throw new Error(`claim failed: ${claimed.error.message}`);
  const messages = claimedRows.parse(claimed.data ?? []);
  summary.claimed = messages.length;

  for (const m of messages) {
    const result = await sendWithTimeout(provider, {
      channel: m.channel as MessageChannel,
      to: m.recipient,
      sender: m.sender,
      subject: m.subject,
      body: m.body,
    });
    const recorded = await rpc('jobs_record_attempt', {
      p_job_key: jobKey,
      p_notification_id: m.notification_id,
      p_outcome: result.outcome,
      p_provider: provider.name,
      p_provider_message_id: result.providerMessageId ?? null,
      p_error_code: result.errorCode ?? null,
      p_retryable: result.retryable,
    });
    const status = recorded.error ? 'scheduled' : String(recorded.data);
    if (status === 'sent') summary.sent += 1;
    else if (status === 'failed') summary.failed += 1;
    else summary.retrying += 1;
  }
  return summary;
}
