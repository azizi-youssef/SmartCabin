'use client';

import { CalendarCheck2, ChevronLeft, ChevronRight } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';

import { Link } from '@/i18n/navigation';
import { directionOf, type Locale } from '@/i18n/routing';
import { SlotRadioGroup } from '@/modules/appointments/ui/slot-radio-group';
import { sendBookingCode, verifyBookingCode } from '@/modules/identity/actions';
import type { ErrorCode } from '@/shared/lib/errors';
import { formatLocalDay, formatLongDate, formatMoney, formatTime } from '@/shared/lib/format';
import { Button } from '@/shared/ui/button';
import { Captcha, captchaEnabled } from '@/shared/ui/captcha';
import { Field } from '@/shared/ui/field';
import { Checkbox, Input, Select } from '@/shared/ui/form-controls';
import { EmptyState, InlineAlert } from '@/shared/ui/states';

import { bookOnline, fetchOnlineSlots, loadMyPeople, type MyPerson } from '../booking-actions';
import { addDays, doctorsFor, newPersonErrors, servicesOf, slotsByDay, type NewPersonInput, type Offering } from '../booking-domain';

interface ClinicForBooking {
  id: string;
  slug: string;
  timezone: string;
  autoConfirm: boolean;
  maxHorizonDays: number;
  cancelCutoffHours: number;
  offerings: Offering[];
}

type Step = 'slot' | 'identify' | 'person' | 'done';
const WEEK = 7;

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Online booking in four steps (USER_WORKFLOWS §1): slot, phone code, person, confirmation.
 * Slots come from the server; the booking re-checks every rule in one transaction.
 */
export function BookingWizard({ clinic, today, signedIn }: { clinic: ClinicForBooking; today: string; signedIn: boolean }) {
  const t = useTranslations();
  const locale = useLocale() as Locale;
  const dir = directionOf(locale);
  const services = servicesOf(clinic.offerings);
  const [serviceId, setServiceId] = useState(services[0]?.serviceId ?? '');
  const doctors = doctorsFor(clinic.offerings, serviceId);
  const [doctorId, setDoctorId] = useState(doctors[0]?.doctorId ?? '');
  const [weekStart, setWeekStart] = useState(today);
  const [slots, setSlots] = useState<string[] | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('slot');
  const [error, setError] = useState<ErrorCode | null>(null);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<'pending' | 'confirmed' | null>(null);
  const bookingKey = useRef<string | null>(null);
  const lastDay = addDays(today, clinic.maxHorizonDays - 1);

  const offering = clinic.offerings.find((o) => o.serviceId === serviceId && o.doctorId === doctorId);
  const name = (fr: string, ar: string | null) => (locale === 'ar' && ar ? ar : fr);

  const loadSlots = useCallback((from: string) => {
    if (!serviceId || !doctorId) return;
    setSlots(null);
    setSlot(null);
    const to = addDays(from, WEEK - 1) > lastDay ? lastDay : addDays(from, WEEK - 1);
    startTransition(async () => {
      const r = await fetchOnlineSlots({ slug: clinic.slug, doctorId, serviceId, from, to });
      if (r.ok) setSlots(r.data);
      else {
        setSlots([]);
        setError(r.code);
      }
    });
  }, [clinic.slug, doctorId, serviceId, lastDay]);

  useEffect(() => {
    const timer = setTimeout(() => loadSlots(weekStart), 0);
    return () => clearTimeout(timer);
  }, [loadSlots, weekStart]);

  if (step === 'done' && result) {
    return (
      <div className="grid gap-4 rounded-lg border border-line bg-surface p-5" role="status">
        <EmptyState
          icon={CalendarCheck2}
          className="px-0 py-0"
          title={result === 'confirmed' ? t('booking.doneConfirmedTitle') : t('booking.donePendingTitle')}
          description={result === 'confirmed' ? t('booking.doneConfirmedBody') : t('booking.donePendingBody')}
        />
        {slot ? <p className="text-center text-body font-medium text-ink">{`${formatLongDate(locale, slot, clinic.timezone)} · ${formatTime(locale, slot, clinic.timezone)}`}</p> : null}
        <Button asChild variant="primary" size="lg"><Link href="/me">{t('booking.seeMyAppointments')}</Link></Button>
      </div>
    );
  }

  const summary = offering && slot ? (
    <div className="grid gap-0.5 rounded-md border border-line bg-surface-muted px-3 py-2 text-small">
      <span className="font-medium text-ink">{`${formatLongDate(locale, slot, clinic.timezone)} · ${formatTime(locale, slot, clinic.timezone)}`}</span>
      <span className="text-ink-muted">{`${name(offering.serviceNameFr, offering.serviceNameAr)} · ${name(offering.doctorName, offering.doctorNameAr)} · ${formatMoney(locale, offering.priceMad)}`}</span>
      <button type="button" className="focus-ring justify-self-start rounded-sm text-accent hover:underline" onClick={() => setStep('slot')}>{t('booking.change')}</button>
    </div>
  ) : null;

  if (step === 'identify') {
    return (
      <section aria-labelledby="identify-title" className="grid gap-4 rounded-lg border border-line bg-surface p-5">
        <h2 id="identify-title" className="text-heading text-ink">{t('booking.identifyTitle')}</h2>
        {summary}
        <PhoneStep onVerified={() => setStep('person')} />
      </section>
    );
  }

  if (step === 'person') {
    return (
      <section aria-labelledby="person-title" className="grid gap-4 rounded-lg border border-line bg-surface p-5">
        <h2 id="person-title" className="text-heading text-ink">{t('booking.personTitle')}</h2>
        {summary}
        <PersonStep
          clinicId={clinic.id}
          today={today}
          cancelCutoffHours={clinic.cancelCutoffHours}
          autoConfirm={clinic.autoConfirm}
          onBook={async (person) => {
            if (!offering || !slot) return 'VALIDATION_FAILED';
            bookingKey.current ??= newKey();
            const r = await bookOnline({
              clinicId: clinic.id,
              doctorId: offering.doctorId,
              serviceId: offering.serviceId,
              startsAt: slot,
              ...(person.patientId ? { patientId: person.patientId } : {}),
              ...(person.newPerson ? { newPerson: { ...person.newPerson, dataProcessing: true as const, locale } } : {}),
              idempotencyKey: bookingKey.current,
            });
            if (!r.ok) {
              // A taken slot needs a new choice; anything else can be retried with the same key.
              if (r.code === 'SLOT_UNAVAILABLE') {
                bookingKey.current = null;
                setStep('slot');
                setError('SLOT_UNAVAILABLE');
                loadSlots(weekStart);
              }
              return r.code;
            }
            setResult(r.data.status);
            setStep('done');
            return null;
          }}
        />
      </section>
    );
  }

  const groups = slotsByDay(slots ?? [], clinic.timezone);
  return (
    <section aria-labelledby="slot-title" className="grid gap-4 rounded-lg border border-line bg-surface p-5">
      <h2 id="slot-title" className="text-heading text-ink">{t('booking.slotTitle')}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="booking-service" label={t('booking.service')}>
          <Select value={serviceId} onChange={(e) => {
            setServiceId(e.target.value);
            setDoctorId(doctorsFor(clinic.offerings, e.target.value)[0]?.doctorId ?? '');
            setError(null);
          }}>
            {services.map((s) => <option key={s.serviceId} value={s.serviceId}>{`${name(s.serviceNameFr, s.serviceNameAr)} (${t('booking.minutes', { minutes: s.durationMinutes })})`}</option>)}
          </Select>
        </Field>
        <Field id="booking-doctor" label={t('booking.doctor')}>
          <Select value={doctorId} onChange={(e) => { setDoctorId(e.target.value); setError(null); }}>
            {doctors.map((d) => <option key={d.doctorId} value={d.doctorId}>{`${name(d.doctorName, d.doctorNameAr)} — ${formatMoney(locale, d.priceMad)}`}</option>)}
          </Select>
        </Field>
      </div>

      <div className="flex items-center justify-between gap-2">
        <Button size="icon" variant="ghost" aria-label={t('booking.previousWeek')} disabled={weekStart <= today || pending} onClick={() => setWeekStart(addDays(weekStart, -WEEK) < today ? today : addDays(weekStart, -WEEK))}>
          <ChevronLeft aria-hidden className="flip-rtl" />
        </Button>
        <span className="text-small font-medium text-ink" aria-live="polite">
          {t('booking.weekOf', { from: formatLocalDay(locale, weekStart, 'short'), to: formatLocalDay(locale, addDays(weekStart, WEEK - 1) > lastDay ? lastDay : addDays(weekStart, WEEK - 1), 'short') })}
        </span>
        <Button size="icon" variant="ghost" aria-label={t('booking.nextWeek')} disabled={addDays(weekStart, WEEK) > lastDay || pending} onClick={() => setWeekStart(addDays(weekStart, WEEK))}>
          <ChevronRight aria-hidden className="flip-rtl" />
        </Button>
      </div>

      {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
      {slots === null ? (
        <p className="text-small text-ink-muted" aria-live="polite">{t('common.loading')}</p>
      ) : groups.length === 0 ? (
        <p className="text-small text-ink-muted">{t('booking.noSlots')}</p>
      ) : (
        <div className="grid gap-4">
          {groups.map((g) => (
            <div key={g.day} className="grid gap-2">
              <h3 className="text-small font-medium text-ink">{formatLocalDay(locale, g.day)}</h3>
              <SlotRadioGroup
                slots={g.slots.map((s) => ({ startsAt: s }))}
                value={slot}
                onChange={(s) => { setSlot(s?.startsAt ?? null); setError(null); }}
                label={formatLocalDay(locale, g.day)}
                locale={locale}
                timeZone={clinic.timezone}
                dir={dir}
              />
            </div>
          ))}
        </div>
      )}
      <Button variant="primary" size="lg" disabled={!slot || !offering} onClick={() => setStep(signedIn ? 'person' : 'identify')}>
        {t('booking.continue')}
      </Button>
    </section>
  );
}

/** Phone number, CAPTCHA, then the 6-digit SMS code (the account is created if needed). */
function PhoneStep({ onVerified }: { onVerified: () => void }) {
  const t = useTranslations();
  const [phone, setPhone] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<ErrorCode | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);
  const [pending, startTransition] = useTransition();

  if (!sentTo) {
    return (
      <form noValidate className="grid gap-4" onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const r = await sendBookingCode({ phone, ...(captchaToken ? { captchaToken } : {}) });
          setCaptchaKey((k) => k + 1);
          if (r.ok) setSentTo(r.data.phone);
          else setError(r.code);
        });
      }}>
        <Field id="booking-phone" label={t('auth.phone')} hint={t('booking.phoneHint')} required>
          <Input type="tel" inputMode="tel" autoComplete="tel" dir="ltr" className="h-11 text-start" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Captcha onToken={setCaptchaToken} resetKey={captchaKey} />
        {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
        <Button type="submit" variant="primary" size="lg" loading={pending} disabled={phone.trim().length < 9 || (captchaEnabled() && !captchaToken)}>
          {t('auth.sendCode')}
        </Button>
      </form>
    );
  }
  return (
    <form noValidate className="grid gap-4" onSubmit={(e) => {
      e.preventDefault();
      setError(null);
      startTransition(async () => {
        const r = await verifyBookingCode({ phone: sentTo, code });
        if (r.ok) onVerified();
        else setError(r.code);
      });
    }}>
      <p className="text-body text-ink-muted">{t('booking.codeSentTo', { number: sentTo })}</p>
      <Field id="booking-code" label={t('auth.code')} required>
        <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} dir="ltr" className="h-11 text-center text-heading tracking-[0.4em] tabular"
          value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
      </Field>
      {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
      <Button type="submit" variant="primary" size="lg" loading={pending} disabled={code.length !== 6}>{t('booking.verify')}</Button>
      <button type="button" className="focus-ring justify-self-center rounded-sm text-small text-accent hover:underline" onClick={() => { setSentTo(null); setCode(''); }}>
        {t('booking.otherNumber')}
      </button>
    </form>
  );
}

const EMPTY_PERSON: NewPersonInput = { firstName: '', lastName: '', relationship: 'self', dateOfBirth: '', dataProcessing: false, remindersSms: true };

/** Who the appointment is for: a person already linked to this account, or a new one. */
function PersonStep({ clinicId, today, cancelCutoffHours, autoConfirm, onBook }: {
  clinicId: string;
  today: string;
  cancelCutoffHours: number;
  autoConfirm: boolean;
  onBook: (person: { patientId?: string; newPerson?: Omit<NewPersonInput, 'dataProcessing'> }) => Promise<ErrorCode | null>;
}) {
  const t = useTranslations();
  const [people, setPeople] = useState<MyPerson[] | null>(null);
  const [choice, setChoice] = useState<string>('new');
  const [person, setPerson] = useState<NewPersonInput>(EMPTY_PERSON);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let alive = true;
    void loadMyPeople({ clinicId }).then((r) => {
      if (!alive) return;
      const list = r.ok ? r.data : [];
      setPeople(list);
      if (list[0]) setChoice(list[0].patientId);
      if (list.some((p) => p.relationship === 'self')) setPerson((p) => ({ ...p, relationship: 'child' }));
    });
    return () => {
      alive = false;
    };
  }, [clinicId]);

  const hasSelf = (people ?? []).some((p) => p.relationship === 'self');
  const errors = choice === 'new' ? newPersonErrors(person, today) : {};
  const invalid = Object.keys(errors).length > 0;
  const fieldError = (k: keyof NewPersonInput) => (touched && errors[k] ? t(errors[k] === 'required' ? 'booking.required' : 'booking.invalid') : undefined);

  if (people === null) return <p className="text-small text-ink-muted" aria-live="polite">{t('common.loading')}</p>;
  return (
    <form noValidate className="grid gap-4" onSubmit={(e) => {
      e.preventDefault();
      setTouched(true);
      if (invalid) return;
      setError(null);
      startTransition(async () => {
        const newPerson = {
          firstName: person.firstName, lastName: person.lastName, relationship: person.relationship,
          dateOfBirth: person.dateOfBirth, remindersSms: person.remindersSms,
        };
        const code = await onBook(choice === 'new' ? { newPerson } : { patientId: choice });
        if (code) setError(code);
      });
    }}>
      {people.length > 0 ? (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-small font-medium text-ink">{t('booking.forWhom')}</legend>
          {people.map((p) => (
            <label key={p.patientId} className="flex cursor-pointer items-center gap-2.5 rounded-md border border-line px-3 py-2.5 text-body has-[:checked]:border-accent">
              <input type="radio" name="person" className="focus-ring size-4 accent-[var(--sc-teal-600)]" checked={choice === p.patientId} onChange={() => setChoice(p.patientId)} />
              <span>{`${p.firstName} ${p.lastName}`}</span>
              <span className="ms-auto text-caption text-ink-muted">{t(`booking.relationship.${p.relationship}`)}</span>
            </label>
          ))}
          <label className="flex cursor-pointer items-center gap-2.5 rounded-md border border-line px-3 py-2.5 text-body has-[:checked]:border-accent">
            <input type="radio" name="person" className="focus-ring size-4 accent-[var(--sc-teal-600)]" checked={choice === 'new'} onChange={() => setChoice('new')} />
            <span>{t('booking.someoneElse')}</span>
          </label>
        </fieldset>
      ) : null}

      {choice === 'new' ? (
        <div className="grid gap-3">
          <p className="text-small text-ink-muted">{t('booking.newPersonHint')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="np-first" label={t('booking.firstName')} required error={fieldError('firstName')}>
              <Input autoComplete="given-name" maxLength={80} value={person.firstName} onChange={(e) => setPerson({ ...person, firstName: e.target.value })} />
            </Field>
            <Field id="np-last" label={t('booking.lastName')} required error={fieldError('lastName')}>
              <Input autoComplete="family-name" maxLength={80} value={person.lastName} onChange={(e) => setPerson({ ...person, lastName: e.target.value })} />
            </Field>
            <Field id="np-relationship" label={t('booking.relationshipLabel')} required>
              <Select value={person.relationship} onChange={(e) => setPerson({ ...person, relationship: e.target.value as NewPersonInput['relationship'] })}>
                {(hasSelf ? (['child', 'other_dependent'] as const) : (['self', 'child', 'other_dependent'] as const)).map((r) => (
                  <option key={r} value={r}>{t(`booking.relationship.${r}`)}</option>
                ))}
              </Select>
            </Field>
            <Field id="np-birth" label={t('booking.dateOfBirth')} optionalLabel={t('common.optional')} error={fieldError('dateOfBirth')}>
              <Input type="date" dir="ltr" max={today} value={person.dateOfBirth} onChange={(e) => setPerson({ ...person, dateOfBirth: e.target.value })} />
            </Field>
          </div>
          <Checkbox id="np-consent" checked={person.dataProcessing} onChange={(e) => setPerson({ ...person, dataProcessing: e.target.checked })}
            label={t('booking.consentData')} description={t('booking.consentDataHint')} aria-invalid={touched && errors.dataProcessing ? true : undefined} />
          {touched && errors.dataProcessing ? <p className="text-small text-danger" role="alert">{t('booking.consentRequired')}</p> : null}
          <Checkbox id="np-sms" checked={person.remindersSms} onChange={(e) => setPerson({ ...person, remindersSms: e.target.checked })}
            label={t('booking.consentSms')} description={t('booking.consentSmsHint')} />
        </div>
      ) : null}

      <p className="text-small text-ink-muted">
        {autoConfirm ? t('booking.policyAuto', { hours: cancelCutoffHours }) : t('booking.policyPending', { hours: cancelCutoffHours })}
      </p>
      {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
      <Button type="submit" variant="primary" size="lg" loading={pending}>{t('booking.confirm')}</Button>
    </form>
  );
}
