'use client';

import { useTranslations } from 'next-intl';

import { usePathname, useRouter } from '@/i18n/navigation';
import { Select } from '@/shared/ui/form-controls';

/** Narrows an agenda to one doctor; the choice lives in the URL (?doctor=…). */
export function DoctorFilter({
  doctors,
  value,
  params,
}: {
  doctors: Array<{ id: string; name: string }>;
  value: string;
  params: Record<string, string>;
}) {
  const t = useTranslations('reception');
  const pathname = usePathname();
  const router = useRouter();
  return (
    <div className="flex items-center gap-2">
      <label htmlFor="doctor-filter" className="text-small text-ink-muted">
        {t('filterDoctor')}
      </label>
      <Select
        id="doctor-filter"
        className="w-56"
        value={value}
        onChange={(e) => {
          const query = { ...params };
          if (e.target.value) query.doctor = e.target.value;
          else delete query.doctor;
          router.push({ pathname, query });
        }}
      >
        <option value="">{t('allDoctors')}</option>
        {doctors.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </Select>
    </div>
  );
}
