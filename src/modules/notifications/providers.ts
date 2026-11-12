import { randomUUID } from 'node:crypto';

/*
 * Message providers (module 9). The real SMS, WhatsApp and e-mail providers are not chosen yet
 * (commercial decision). Until then:
 * - "disabled" (default): messages are planned and stay scheduled; nothing is sent;
 * - "simulator" (development, staging): every message is accepted, nothing leaves the server.
 * A real adapter implements the same interface and maps provider errors to `retryable`.
 */

export type MessageChannel = 'sms' | 'whatsapp' | 'email' | 'push';

export interface OutboundMessage {
  channel: MessageChannel;
  to: string;
  sender: string | null;
  subject: string | null;
  body: string;
}

export interface SendResult {
  outcome: 'accepted' | 'rejected' | 'error' | 'timeout';
  providerMessageId?: string;
  errorCode?: string;
  /** Transient failure (network, rate limit, provider 5xx): try again later. */
  retryable: boolean;
}

export interface MessageProvider {
  readonly name: string;
  readonly enabled: boolean;
  send(message: OutboundMessage): Promise<SendResult>;
}

export const disabledProvider: MessageProvider = {
  name: 'disabled',
  enabled: false,
  send: async () => ({ outcome: 'error', errorCode: 'PROVIDER_DISABLED', retryable: true }),
};

export const simulatorProvider: MessageProvider = {
  name: 'simulator',
  enabled: true,
  send: async () => ({ outcome: 'accepted', providerMessageId: `sim-${randomUUID()}`, retryable: false }),
};

export function providerFromEnv(value: string | undefined = process.env['NOTIFICATIONS_PROVIDER']): MessageProvider {
  return value === 'simulator' ? simulatorProvider : disabledProvider;
}

/** A provider call that never hangs the worker: past `ms`, it counts as a retryable timeout. */
export async function sendWithTimeout(provider: MessageProvider, message: OutboundMessage, ms = 10_000): Promise<SendResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SendResult>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: 'timeout', errorCode: 'TIMEOUT', retryable: true }), ms);
  });
  try {
    return await Promise.race([
      provider.send(message).catch((): SendResult => ({ outcome: 'error', errorCode: 'PROVIDER_EXCEPTION', retryable: true })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
