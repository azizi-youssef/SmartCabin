import { useTranslations } from 'next-intl';

import { Badge } from '@/shared/ui/badge';

import { INVOICE_STATUS_TONE, type InvoiceStatus } from '../domain';

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const t = useTranslations('billing.status');
  return (
    <Badge tone={INVOICE_STATUS_TONE[status]} dot>
      {t(status)}
    </Badge>
  );
}
