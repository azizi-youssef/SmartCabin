import { useTranslations } from 'next-intl';

import { Badge } from '@/shared/ui/badge';

import { STATUS_TONE, type AppointmentStatus } from '../domain/status';

export function AppointmentStatusBadge({ status }: { status: AppointmentStatus }) {
  const t = useTranslations('appointmentStatus');
  return (
    <Badge tone={STATUS_TONE[status]} dot>
      {t(status)}
    </Badge>
  );
}
