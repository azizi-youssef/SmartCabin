'use client';

import { UserPlus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState, useTransition } from 'react';

import { useRouter } from '@/i18n/navigation';
import { PatientLookup, type BookingCatalog } from '@/modules/appointments/ui/booking-dialog';
import type { PatientOption } from '@/modules/patients/actions';
import type { ErrorCode } from '@/shared/lib/errors';
import { Button } from '@/shared/ui/button';
import { Dialog, DialogContent, DialogTrigger } from '@/shared/ui/dialog';
import { Field, FieldGrid } from '@/shared/ui/field';
import { Input, Label, Select } from '@/shared/ui/form-controls';
import { InlineAlert } from '@/shared/ui/states';
import { useToast } from '@/shared/ui/toast';

import { registerWalkIn } from '../actions';

/**
 * A patient without an appointment (A3, MD-10): an appointment is created directly checked in,
 * then its ticket. It queues by arrival time and does not take an agenda slot. The idempotency key
 * is created when the dialog opens, so a double click cannot register the patient twice.
 */
export function WalkInDialog({ slug, catalog }: { slug: string; catalog: BookingCatalog }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [patient, setPatient] = useState<PatientOption | null>(null);
  const [doctorId, setDoctorId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [visitReason, setVisitReason] = useState('');
  const [error, setError] = useState<ErrorCode | null>(null);
  const [pending, startTransition] = useTransition();

  const services = useMemo(
    () => catalog.services.filter((s) => catalog.offerings.some((o) => o.doctorId === doctorId && o.serviceId === s.id)),
    [catalog, doctorId],
  );

  function reset(next: boolean) {
    setOpen(next);
    if (next) {
      setKey(crypto.randomUUID());
      setPatient(null);
      setDoctorId(catalog.doctors.length === 1 ? (catalog.doctors[0]?.id ?? '') : '');
      setServiceId('');
      setVisitReason('');
      setError(null);
    }
  }

  function submit() {
    if (!patient || !doctorId || !serviceId) return;
    setError(null);
    startTransition(async () => {
      const result = await registerWalkIn({
        clinicSlug: slug,
        patientId: patient.id,
        doctorId,
        serviceId,
        idempotencyKey: key,
        ...(visitReason.trim() ? { patientReason: visitReason.trim() } : {}),
      });
      if (!result.ok) return setError(result.code);
      toast({ tone: 'success', title: t('reception.walkInDone', { ticket: result.data.ticket }) });
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger asChild>
        <Button variant="secondary">
          <UserPlus aria-hidden />
          {t('reception.walkIn')}
        </Button>
      </DialogTrigger>
      <DialogContent
        title={t('reception.walkInTitle')}
        description={t('reception.walkInDescription')}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button variant="secondary" onClick={() => reset(false)} disabled={pending}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={submit} loading={pending} disabled={!patient || !doctorId || !serviceId}>
              {t('reception.walkInSubmit')}
            </Button>
          </>
        }
      >
        <div className="grid gap-5">
          <div className="grid gap-1.5">
            <Label htmlFor="booking-patient" className="flex items-baseline gap-1.5">
              <span>{t('booking.patient')}</span>
              <span aria-hidden className="text-danger">
                *
              </span>
            </Label>
            <PatientLookup slug={slug} value={patient} onChange={setPatient} />
          </div>
          <FieldGrid>
            <Field id="walk-in-doctor" label={t('booking.doctor')} required>
              <Select
                value={doctorId}
                onChange={(e) => {
                  setDoctorId(e.target.value);
                  setServiceId('');
                }}
              >
                <option value="">{t('common.selectPlaceholder')}</option>
                {catalog.doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="walk-in-service" label={t('booking.service')} required>
              <Select value={serviceId} disabled={!doctorId} onChange={(e) => setServiceId(e.target.value)}>
                <option value="">{t('common.selectPlaceholder')}</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          </FieldGrid>
          <Field id="walk-in-visit-reason" label={t('booking.visitReason')} hint={t('booking.visitReasonHint')} optionalLabel={t('common.optional')}>
            <Input maxLength={200} value={visitReason} onChange={(e) => setVisitReason(e.target.value)} />
          </Field>
          {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
