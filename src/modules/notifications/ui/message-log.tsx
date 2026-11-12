import { getLocale, getTranslations } from 'next-intl/server';

import type { Locale } from '@/i18n/routing';
import { formatDateTime } from '@/shared/lib/format';
import type { Loaded } from '@/shared/lib/result';
import { Badge, type BadgeTone } from '@/shared/ui/badge';

import type { MessageLogEntry, NotificationStatus } from '../queries';

const STATUS_TONE: Record<NotificationStatus, BadgeTone> = {
  scheduled: 'info',
  processing: 'info',
  sent: 'success',
  delivered: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  skipped: 'warning',
};

/** Read-only log of the messages planned for an appointment: what, how, when, and the outcome. */
export async function MessageLog({ messages, timeZone }: { messages: Loaded<MessageLogEntry[]>; timeZone: string }) {
  const t = await getTranslations('notifications');
  const locale = (await getLocale()) as Locale;
  if (messages.status !== 'ok') return <p className="text-small text-ink-muted">{t('logUnavailable')}</p>;
  if (messages.data.length === 0) return <p className="text-small text-ink-muted">{t('logEmpty')}</p>;
  return (
    <ul className="grid gap-0 rounded-lg border border-line bg-surface">
      {messages.data.map((m) => {
        const when = m.sentAt ?? m.failedAt ?? m.scheduledFor;
        return (
          <li key={m.id} className="grid gap-1 border-b border-line px-4 py-3 last:border-b-0">
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-body text-ink">{t(`event.${m.eventType}`)}</span>
              <Badge tone={STATUS_TONE[m.status]}>{t(`status.${m.status}`)}</Badge>
            </span>
            <span className="text-caption text-ink-subtle">
              {t(`channel.${m.channel}`)}
              {m.recipientMasked ? <span dir="ltr" className="tabular"> · {m.recipientMasked}</span> : null}
              {' · '}
              <time dateTime={when} className="tabular">{formatDateTime(locale, when, timeZone)}</time>
              {m.attemptCount > 1 ? ` · ${t('attempts', { count: m.attemptCount })}` : null}
            </span>
            {m.skipReason ? <span className="text-small text-ink-muted">{t(`skipReason.${m.skipReason}`)}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
