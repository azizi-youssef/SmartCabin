'use client';

import { CalendarPlus, Search, UserRound } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState, useTransition } from 'react';

import { useRouter } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { findPatients, type PatientOption } from '@/modules/patients/actions';
import { formatTime } from '@/shared/lib/format';
import type { ErrorCode } from '@/shared/lib/errors';
import { zonedInstant } from '@/shared/lib/time';
import { Button } from '@/shared/ui/button';
import { Dialog, DialogContent, DialogTrigger } from '@/shared/ui/dialog';
import { Field, FieldGrid } from '@/shared/ui/field';
import { Checkbox, Input, Label, Select, Textarea } from '@/shared/ui/form-controls';
import { InlineAlert } from '@/shared/ui/states';
import { useToast } from '@/shared/ui/toast';

import { bookAppointment, rescheduleAppointment, type SlotOption } from '../actions';
import { SlotPicker } from './slot-picker';

export interface BookingCatalog {
  doctors: Array<{ id: string; name: string }>;
  services: Array<{ id: string; name: string }>;
  offerings: Array<{ doctorId: string; serviceId: string }>;
}

/** Patient lookup with debounce; shows at most 8 matches. */
function PatientLookup({ slug, value, onChange }: { slug: string; value: PatientOption | null; onChange: (p: PatientOption | null) => void }) {
  const t = useTranslations('booking');
  const te = useTranslations('errors');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PatientOption[]>([]);
  const [error, setError] = useState<ErrorCode | null>(null);
  const [pending, startTransition] = useTransition();
  const tooShort = query.trim().length < 2;

  useEffect(() => {
    if (tooShort) return;
    const timer = setTimeout(() => {
      startTransition(async () => {
        const result = await findPatients(slug, query);
        if (result.ok) {
          setResults(result.data);
          setError(null);
        } else {
          setError(result.code);
        }
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [query, slug, tooShort]);

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-line bg-surface-muted px-3 py-2">
        <span className="flex min-w-0 items-center gap-2">
          <UserRound aria-hidden className="size-4 shrink-0 text-ink-subtle" />
          <span className="truncate text-body font-medium">{value.label}</span>
          <span className="text-small text-ink-muted tabular">{value.fileNumber}</span>
        </span>
        <Button variant="link" size="sm" onClick={() => onChange(null)}>
          {t('changePatient')}
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle" />
        <Input
          id="booking-patient"
          type="search"
          autoComplete="off"
          className="ps-9"
          placeholder={t('patientSearch')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-describedby="booking-patient-status"
        />
      </div>
      <p id="booking-patient-status" className="text-small text-ink-muted" aria-live="polite">
        {tooShort ? t('patientMin') : error ? te(error) : !pending && results.length === 0 ? t('patientNone') : null}
      </p>
      {!tooShort && results.length > 0 ? (
        <ul className="grid max-h-56 divide-y divide-line overflow-y-auto rounded-md border border-line">
          {results.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onChange(p)}
                className="focus-ring flex w-full items-center justify-between gap-3 px-3 py-2 text-start hover:bg-surface-sunken"
              >
                <span className="truncate text-body">{p.label}</span>
                <span className="text-small text-ink-muted tabular">{p.fileNumber}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * New appointment: patient → doctor → service → day → free slot (or an explicit, justified
 * overbooking). The idempotency key is created when the dialog opens, so a double click or a
 * network retry cannot create two appointments.
 */
export function BookingDialog({
  slug,
  timeZone,
  defaultDay,
  catalog,
  canOverbook,
}: {
  slug: string;
  timeZone: string;
  defaultDay: string;
  catalog: BookingCatalog;
  canOverbook: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale() as Locale;
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [patient, setPatient] = useState<PatientOption | null>(null);
  const [doctorId, setDoctorId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [day, setDay] = useState(defaultDay);
  const [slot, setSlot] = useState<SlotOption | null>(null);
  const [overbook, setOverbook] = useState(false);
  const [overbookTime, setOverbookTime] = useState('');
  const [overbookReason, setOverbookReason] = useState('');
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
      setDay(defaultDay);
      setSlot(null);
      setOverbook(false);
      setOverbookTime('');
      setOverbookReason('');
      setError(null);
    }
  }

  const startsAt = overbook
    ? overbookTime
      ? zonedInstant(day, overbookTime, timeZone).toISOString()
      : null
    : slot?.startsAt ?? null;
  const canSubmit = Boolean(patient && doctorId && serviceId && startsAt && (!overbook || overbookReason.trim().length >= 3));

  function submit() {
    if (!patient || !startsAt) return;
    setError(null);
    startTransition(async () => {
      const result = await bookAppointment({
        clinicSlug: slug,
        patientId: patient.id,
        doctorId,
        serviceId,
        startsAt,
        idempotencyKey: key,
        ...(overbook ? { overbookReason: overbookReason.trim() } : {}),
      });
      if (!result.ok) {
        setError(result.code);
        if (result.code === 'SLOT_UNAVAILABLE') setSlot(null);
        return;
      }
      toast({ tone: 'success', title: t('reception.bookDone') });
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger asChild>
        <Button variant="primary">
          <CalendarPlus aria-hidden />
          {t('reception.newAppointment')}
        </Button>
      </DialogTrigger>
      <DialogContent
        title={t('booking.title')}
        description={t('booking.description')}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button variant="secondary" onClick={() => reset(false)} disabled={pending}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={submit} loading={pending} disabled={!canSubmit}>
              {t('booking.submit')}
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
            <Field id="booking-doctor" label={t('booking.doctor')} required>
              <Select
                value={doctorId}
                onChange={(e) => {
                  setDoctorId(e.target.value);
                  setServiceId('');
                  setSlot(null);
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
            <Field id="booking-service" label={t('booking.service')} required>
              <Select
                value={serviceId}
                disabled={!doctorId}
                onChange={(e) => {
                  setServiceId(e.target.value);
                  setSlot(null);
                }}
              >
                <option value="">{t('common.selectPlaceholder')}</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="booking-day" label={t('booking.day')} required>
              <Input
                type="date"
                className="tabular"
                value={day}
                onChange={(e) => {
                  setDay(e.target.value);
                  setSlot(null);
                }}
              />
            </Field>
          </FieldGrid>

          {!overbook ? (
            <fieldset className="grid gap-2">
              <legend className="mb-1.5 text-small font-medium text-ink">{t('booking.slots')}</legend>
              <SlotPicker doctorId={doctorId} serviceId={serviceId} day={day} timeZone={timeZone} value={slot?.startsAt ?? null} onChange={setSlot} />
              {slot ? (
                <p className="text-small text-ink-muted">
                  {t('booking.slotSelected', { time: formatTime(locale, slot.startsAt, timeZone) })}
                </p>
              ) : null}
            </fieldset>
          ) : null}

          {canOverbook ? (
            <div className="grid gap-3 rounded-md border border-line bg-surface-muted p-3">
              <Checkbox
                label={t('booking.overbook')}
                description={t('booking.overbookHint')}
                checked={overbook}
                onChange={(e) => {
                  setOverbook(e.target.checked);
                  setSlot(null);
                }}
              />
              {overbook ? (
                <FieldGrid>
                  <Field id="booking-overbook-time" label={t('booking.overbookTime')} required>
                    <Input type="time" step={300} className="tabular" value={overbookTime} onChange={(e) => setOverbookTime(e.target.value)} />
                  </Field>
                  <Field id="booking-overbook-reason" label={t('booking.overbookReason')} required className="sm:col-span-2">
                    <Textarea rows={2} maxLength={200} value={overbookReason} onChange={(e) => setOverbookReason(e.target.value)} />
                  </Field>
                </FieldGrid>
              ) : null}
            </div>
          ) : null}

          {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Moves an appointment to another free slot (same doctor and service). */
export function RescheduleDialog({
  appointment,
  timeZone,
  open,
  onOpenChange,
}: {
  appointment: { id: string; version: number; doctorId: string; serviceId: string; day: string };
  timeZone: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations();
  const locale = useLocale() as Locale;
  const router = useRouter();
  const toast = useToast();
  const [day, setDay] = useState(appointment.day);
  const [slot, setSlot] = useState<SlotOption | null>(null);
  const [error, setError] = useState<ErrorCode | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    if (!slot) return;
    setError(null);
    startTransition(async () => {
      const result = await rescheduleAppointment({ id: appointment.id, version: appointment.version, startsAt: slot.startsAt });
      if (!result.ok) {
        setError(result.code);
        if (result.code === 'STALE_STATE') router.refresh();
        return;
      }
      toast({ tone: 'success', title: t('reception.rescheduleDone') });
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('booking.rescheduleTitle')}
        description={t('booking.description')}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={submit} loading={pending} disabled={!slot}>
              {t('booking.rescheduleSubmit')}
            </Button>
          </>
        }
      >
        <div className="grid gap-5">
          <Field id="reschedule-day" label={t('booking.day')} required className="max-w-xs">
            <Input
              type="date"
              className="tabular"
              value={day}
              onChange={(e) => {
                setDay(e.target.value);
                setSlot(null);
              }}
            />
          </Field>
          <fieldset className="grid gap-2">
            <legend className="mb-1.5 text-small font-medium text-ink">{t('booking.slots')}</legend>
            <SlotPicker
              doctorId={appointment.doctorId}
              serviceId={appointment.serviceId}
              day={day}
              timeZone={timeZone}
              value={slot?.startsAt ?? null}
              onChange={setSlot}
            />
            {slot ? (
              <p className="text-small text-ink-muted">{t('booking.slotSelected', { time: formatTime(locale, slot.startsAt, timeZone) })}</p>
            ) : null}
          </fieldset>
          {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
