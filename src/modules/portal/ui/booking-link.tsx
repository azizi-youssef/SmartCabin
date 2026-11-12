'use client';

import { Copy, ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/form-controls';
import { InlineAlert } from '@/shared/ui/states';

/** The clinic's public booking link (S7), to share or print; a QR code can be made from it. */
export function BookingLinkPanel({ url, enabled }: { url: string; enabled: boolean }) {
  const t = useTranslations('settings.bookingLink');
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-3 rounded-lg border border-line bg-surface p-4">
      {!enabled ? <InlineAlert tone="warning">{t('disabled')}</InlineAlert> : null}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="booking-link" className="sr-only">{t('label')}</label>
        <Input id="booking-link" readOnly dir="ltr" value={url} className="min-w-0 flex-1 text-start" onFocus={(e) => e.currentTarget.select()} />
        <Button
          variant="secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              setCopied(false);
            }
          }}
        >
          <Copy aria-hidden />
          {copied ? t('copied') : t('copy')}
        </Button>
        <Button asChild variant="ghost">
          <a href={url} target="_blank" rel="noopener noreferrer">
            <ExternalLink aria-hidden />
            {t('open')}
          </a>
        </Button>
      </div>
      <p role="status" className="sr-only">{copied ? t('copied') : ''}</p>
    </div>
  );
}
