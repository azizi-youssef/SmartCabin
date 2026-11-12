import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { actAs, asAnon, asPostgres, asUser, count, createPool, failure, one, withRollback, type Db } from './helpers/db';
import { createUser, createWorld, localInstant, type World } from './helpers/fixtures';

/**
 * Slice S7 — patient portal (migration 0030): the account-creation hook (SC-AUD-01), the public
 * booking page (anon), online booking (A1/A2, BR-B-01…11, BR-D-02), cancellation by the patient
 * (A6) and expiry of unconfirmed bookings (A7).
 */
let pool: pg.Pool;
beforeAll(() => {
  pool = createPool(2);
});
afterAll(async () => {
  await pool.end();
});

const NEW_SELF = { first_name: 'Nadia', last_name: 'Test', relationship: 'self', data_processing: true, reminders_sms: true };

async function scenario(fn: (db: Db, w: World) => Promise<void>): Promise<void> {
  await withRollback(pool, async (db) => fn(db, await createWorld(db)));
}

/** Doctor A1 offers service A online; clinic A takes online bookings. */
async function openOnline(db: Db, w: World, settings: Record<string, unknown> = {}): Promise<void> {
  await actAs(db, asPostgres);
  await db.query('update public.doctors set online_bookable = true where id = $1', [w.doctorA1]);
  await db.query('update public.clinic_settings set online_booking_enabled = true where clinic_id = $1', [w.clinicA]);
  for (const [column, value] of Object.entries(settings)) {
    await db.query(`update public.clinic_settings set ${column} = $2 where clinic_id = $1`, [w.clinicA, value]);
  }
}

async function slug(db: Db, clinic: string): Promise<string> {
  await actAs(db, asPostgres);
  return (await one<{ slug: string }>(db, 'select slug::text from public.clinics where id = $1', [clinic])).slug;
}

async function book(db: Db, w: World, user: string, time: string, person: { patientId?: string; newPerson?: object }, key: string | null = null) {
  const startsAt = await localInstant(db, w.day, time);
  await actAs(db, asUser(user));
  return one<{ appointment_id: string; status: string }>(db,
    'select * from public.portal_book_appointment($1, $2, $3, $4, $5, $6::jsonb, $7)',
    [w.clinicA, w.doctorA1, w.serviceA, startsAt, person.patientId ?? null, person.newPerson ? JSON.stringify(person.newPerson) : null, key]);
}

describe('account creation guard (SC-AUD-01)', () => {
  it('lets Supabase Auth create phone accounts for Moroccan mobile numbers only', async () => {
    await withRollback(pool, async (db) => {
      await actAs(db, asPostgres);
      await db.query('set local role supabase_auth_admin');
      const hook = async (user: object) => (await one<{ r: Record<string, unknown> }>(db, 'select public.before_user_created($1::jsonb) as r', [JSON.stringify({ user })])).r;
      for (const phone of ['212612345678', '+212712345678']) expect(await hook({ phone }), phone).toEqual({});
      expect(await hook({ email: 'owner@example.test', phone: '' })).toEqual({});
      for (const phone of ['33612345678', '212512345678', '19005550100', '882123456789', '99912345678']) {
        expect(await hook({ phone }), phone).toMatchObject({ error: { http_code: 403 } });
      }
      await db.query('reset role');
      for (const principal of [asAnon, asUser(await createUser(db))]) {
        await actAs(db, principal);
        expect((await failure(db, "select public.before_user_created('{}'::jsonb)")).code).toBe('42501');
      }
    });
  });
});

describe('public booking page (anon)', () => {
  it('shows the online offer and free slot times, and nothing about patients', async () => {
    await scenario(async (db, w) => {
      await openOnline(db, w);
      const s = await slug(db, w.clinicA);
      await actAs(db, asAnon);
      const profile = await one<Record<string, unknown>>(db, 'select * from public.public_get_clinic_profile($1)', [s]);
      expect(profile).toMatchObject({ clinic_id: w.clinicA, display_name: 'Test Clinic A', online_booking_open: true, min_lead_minutes: 60 });
      expect(Object.keys(profile).sort()).toEqual([
        'address_line', 'auto_confirm_online', 'city', 'clinic_id', 'default_locale', 'display_name', 'max_horizon_days',
        'min_lead_minutes', 'offerings', 'online_booking_open', 'patient_cancel_cutoff_hours', 'phone_e164', 'slug', 'timezone',
      ]);
      expect((profile['offerings'] as Array<Record<string, unknown>>).map((o) => [o['doctor_id'], o['service_id'], o['price_mad']]))
        .toEqual([[w.doctorA1, w.serviceA, 200]]); // doctor A2 is not bookable online

      const slots = 'select slot_starts_at from public.public_get_available_slots($1, $2, $3, $4::date, $4::date)';
      const free = (await db.query<{ slot_starts_at: string }>(slots, [s, w.doctorA1, w.serviceA, w.day])).rows.map((r) => new Date(r.slot_starts_at).toISOString());
      // 08:00–16:00 in 20-minute slots (time off from 16:00), minus the 09:00 appointment.
      expect(free.length).toBe(23);
      expect(free[0]).toBe(new Date(await localInstant(db, w.day, '08:00')).toISOString());
      await actAs(db, asAnon);
      expect(free).not.toContain(new Date(await localInstant(db, w.day, '09:00')).toISOString());
      await actAs(db, asAnon);
      expect((await failure(db, slots, [s, w.doctorA2, w.serviceA2, w.day])).message).toBe('SERVICE_NOT_OFFERED');
      expect((await failure(db, 'select * from public.public_get_available_slots($1, $2, $3, $4::date, $4::date + 20)', [s, w.doctorA1, w.serviceA, w.day])).message)
        .toBe('VALIDATION_FAILED');
      expect((await failure(db, slots, [s, w.doctorB1, w.serviceB, w.day])).message).toBe('NOT_FOUND'); // another clinic's doctor

      // BR-B-07: beyond the horizon there is nothing to offer.
      await openOnline(db, w, { max_horizon_days: 7 });
      await actAs(db, asAnon);
      expect(await count(db, slots, [s, w.doctorA1, w.serviceA, w.day])).toBe(0);

      // Online booking off: the page stays public, the offer and the slots disappear.
      await actAs(db, asPostgres);
      await db.query('update public.clinic_settings set online_booking_enabled = false where clinic_id = $1', [w.clinicA]);
      await actAs(db, asAnon);
      expect(await one(db, 'select online_booking_open, offerings from public.public_get_clinic_profile($1)', [s]))
        .toEqual({ online_booking_open: false, offerings: [] });
      expect((await failure(db, slots, [s, w.doctorA1, w.serviceA, w.day])).message).toBe('NOT_FOUND');

      // A clinic not yet approved (or suspended) has no public page.
      await actAs(db, asPostgres);
      await db.query("update public.clinics set status = 'suspended', suspended_reason = 'test' where id = $1", [w.clinicA]);
      await actAs(db, asAnon);
      expect((await failure(db, 'select * from public.public_get_clinic_profile($1)', [s])).message).toBe('NOT_FOUND');
      expect((await failure(db, 'select * from public.public_get_clinic_profile($1)', ['no-such-clinic'])).message).toBe('NOT_FOUND');
    });
  });
});

describe('online booking (A1, A2)', () => {
  it('books for a new person linked to the account: pending until the clinic confirms, or confirmed at once', async () => {
    await scenario(async (db, w) => {
      await openOnline(db, w);
      const account = await createUser(db, { phone: '212612345678' });
      const first = await book(db, w, account, '10:00', { newPerson: NEW_SELF }, 'portal-key-0001');
      expect(first.status).toBe('pending');
      expect((await book(db, w, account, '10:00', { newPerson: NEW_SELF }, 'portal-key-0001')).appointment_id).toBe(first.appointment_id);

      await actAs(db, asPostgres);
      const patient = await one<{ id: string; phone_e164: string; created_via: string; preferred_channel: string }>(db,
        `select p.id, p.phone_e164, p.created_via::text, p.preferred_channel::text
         from public.appointments a join public.patients p on p.id = a.patient_id where a.id = $1`, [first.appointment_id]);
      expect(patient).toMatchObject({ phone_e164: '+212612345678', created_via: 'online', preferred_channel: 'sms' });
      expect(await one(db, 'select relationship::text, linked_via::text from public.patient_accounts where user_id = $1', [account]))
        .toEqual({ relationship: 'self', linked_via: 'online_booking' });
      expect((await db.query('select purpose::text, granted from public.patient_consents where patient_id = $1 order by purpose', [patient.id])).rows)
        .toEqual([{ purpose: 'data_processing', granted: true }, { purpose: 'reminders_sms', granted: true }]);
      expect(await one(db, 'select source::text, booked_by_user_id, price_mad::text from public.appointments where id = $1', [first.appointment_id]))
        .toEqual({ source: 'online', booked_by_user_id: account, price_mad: '200.00' });
      expect(await count(db, "select 1 from public.domain_events where aggregate_id = $1 and event_type = 'appointment.booked'", [first.appointment_id])).toBe(1);
      expect(await one(db, "select actor_type::text from public.appointment_history where appointment_id = $1 and event_type = 'created'", [first.appointment_id]))
        .toEqual({ actor_type: 'patient' });

      await actAs(db, asUser(account));
      expect((await db.query('select patient_id, relationship::text from public.portal_list_my_people($1)', [w.clinicA])).rows)
        .toEqual([{ patient_id: patient.id, relationship: 'self' }]);

      await openOnline(db, w, { auto_confirm_online: true });
      const second = await book(db, w, account, '10:20', { patientId: patient.id });
      expect(second.status).toBe('confirmed');
      await actAs(db, asPostgres);
      expect(await count(db, "select 1 from public.domain_events where aggregate_id = $1 and event_type = 'appointment.confirmed'", [second.appointment_id])).toBe(1);

      const bookSql = 'select * from public.portal_book_appointment($1, $2, $3, $4, null, $5::jsonb)';
      const at = await localInstant(db, w.day, '11:00');
      await actAs(db, asUser(account));
      expect((await failure(db, bookSql, [w.clinicA, w.doctorA1, w.serviceA, at, JSON.stringify(NEW_SELF)])).detail).toBe('self already linked');
      expect((await failure(db, bookSql, [w.clinicA, w.doctorA1, w.serviceA, at, JSON.stringify({ ...NEW_SELF, relationship: 'child', data_processing: false })])).message)
        .toBe('VALIDATION_FAILED');
      // A child is a new record too, linked to the same account (BR-D-02: never found by phone).
      await db.query(bookSql, [w.clinicA, w.doctorA1, w.serviceA, at, JSON.stringify({ ...NEW_SELF, first_name: 'Adam', relationship: 'child' })]);
      expect(await count(db, 'select 1 from public.portal_list_my_people($1)', [w.clinicA])).toBe(2);
    });
  });

  it('enforces the online rules: free slot, lead time, horizon, active booking limit, linked people only', async () => {
    await scenario(async (db, w) => {
      await openOnline(db, w, { max_active_online_bookings: 1 });
      const account = await createUser(db, { phone: '212612345679' });
      const bookSql = 'select * from public.portal_book_appointment($1, $2, $3, $4, $5, $6::jsonb)';
      const person = JSON.stringify(NEW_SELF);
      await actAs(db, asUser(account));
      expect((await failure(db, bookSql, [w.clinicA, w.doctorA1, w.serviceA, await localInstant(db, w.day, '09:00'), null, person])).message).toBe('SLOT_UNAVAILABLE');
      await actAs(db, asUser(account));
      for (const startsAt of [new Date(Date.now() + 30 * 60_000).toISOString(), new Date(Date.now() + 90 * 86_400_000).toISOString()]) {
        expect((await failure(db, bookSql, [w.clinicA, w.doctorA1, w.serviceA, startsAt, null, person])).message).toBe('BOOKING_RULE_VIOLATED');
      }
      expect((await failure(db, bookSql, [w.clinicA, w.doctorA2, w.serviceA2, await localInstant(db, w.day, '11:00'), null, person])).message).toBe('SERVICE_NOT_OFFERED');
      await actAs(db, asUser(account));
      expect((await failure(db, bookSql, [w.clinicA, w.doctorA1, w.serviceA, await localInstant(db, w.day, '11:00'), w.patientA2, null])).message).toBe('NOT_FOUND');

      await book(db, w, account, '10:00', { newPerson: NEW_SELF });
      await actAs(db, asUser(account));
      expect((await failure(db, bookSql, [w.clinicA, w.doctorA1, w.serviceA, await localInstant(db, w.day, '11:00'), null, JSON.stringify({ ...NEW_SELF, relationship: 'child' })])).detail)
        .toBe('active booking limit');

      // Staff accounts (no phone) cannot use the portal; anonymous callers cannot book at all.
      const at = await localInstant(db, w.day, '12:00');
      await actAs(db, asUser(w.users.receptionA));
      expect((await failure(db, bookSql, [w.clinicA, w.doctorA1, w.serviceA, at, null, person])).message).toBe('FORBIDDEN');
      await actAs(db, asAnon);
      expect((await failure(db, bookSql, [w.clinicA, w.doctorA1, w.serviceA, at, null, person])).code).toBe('42501');

      await actAs(db, asPostgres);
      await db.query('update public.clinic_settings set online_booking_enabled = false where clinic_id = $1', [w.clinicA]);
      await actAs(db, asUser(account));
      expect((await failure(db, bookSql, [w.clinicA, w.doctorA1, w.serviceA, at, null, person])).message).toBe('ONLINE_BOOKING_NOT_ALLOWED');
    });
  });
});

describe('cancellation and expiry (A6, A7)', () => {
  it('lets the patient cancel their own booking before the cutoff, and nothing else', async () => {
    await scenario(async (db, w) => {
      await openOnline(db, w);
      const account = await createUser(db, { phone: '212612345680' });
      const booked = await book(db, w, account, '10:00', { newPerson: NEW_SELF });
      const cancel = 'select public.portal_cancel_appointment($1) as s';

      await actAs(db, asUser(w.users.patientAccount));
      expect((await failure(db, cancel, [booked.appointment_id])).message).toBe('NOT_FOUND'); // another account
      await actAs(db, asUser(account));
      const listed = await one<{ clinic_slug: string; cancel_until: Date }>(db, 'select clinic_slug, cancel_until from public.portal_list_my_appointments() where appointment_id = $1', [booked.appointment_id]);
      expect(listed.clinic_slug).toBe(await slug(db, w.clinicA));
      await actAs(db, asUser(account));
      expect(await one(db, cancel, [booked.appointment_id])).toEqual({ s: 'cancelled' });
      expect((await failure(db, cancel, [booked.appointment_id])).message).toBe('APPT_INVALID_TRANSITION');
      await actAs(db, asPostgres);
      expect(await one(db, 'select cancellation_actor::text, cancellation_reason::text, cancelled_by_user_id from public.appointments where id = $1', [booked.appointment_id]))
        .toEqual({ cancellation_actor: 'patient', cancellation_reason: 'patient_request', cancelled_by_user_id: account });

      // Inside the cutoff (here 48 h before an appointment tomorrow), the clinic must be called.
      await db.query('update public.clinic_settings set patient_cancel_cutoff_hours = 48 where clinic_id = $1', [w.clinicA]);
      const tomorrow = await one<{ id: string }>(db,
        `insert into public.appointments (clinic_id, patient_id, doctor_id, service_id, starts_at, ends_at, status, source, price_mad, confirmed_at)
         values ($1, $2, $3, $4, date_trunc('hour', now()) + interval '1 day', date_trunc('hour', now()) + interval '1 day 20 minutes', 'confirmed', 'staff', 200, now())
         returning id`, [w.clinicA, w.patientA1, w.doctorA1, w.serviceA]);
      await actAs(db, asUser(w.users.patientAccount));
      expect((await failure(db, cancel, [tomorrow.id])).detail).toBe('cancellation cutoff passed');
    });
  });

  it('cancels unconfirmed bookings once their start has passed, and only those', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      const insert = (status: string, minutesAgo: number) => one<{ id: string }>(db,
        `insert into public.appointments (clinic_id, patient_id, doctor_id, service_id, starts_at, ends_at, status, source, price_mad, confirmed_at)
         values ($1, $2, $3, $4, to_timestamp(floor(extract(epoch from now() - make_interval(mins => $6)) / 300) * 300),
                 to_timestamp(floor(extract(epoch from now() - make_interval(mins => $6)) / 300) * 300) + interval '20 minutes',
                 $5::public.appointment_status, 'online', 200, case when $5 = 'confirmed' then now() end)
         returning id`, [w.clinicA, w.patientA1, w.doctorA1, w.serviceA, status, minutesAgo]);
      const late = await insert('pending', 60);
      const kept = await insert('confirmed', 120);
      expect(await one(db, 'select private.expire_pending_appointments() as n')).toEqual({ n: 1 });
      expect(await one(db, 'select status::text, cancellation_actor::text, cancellation_reason::text from public.appointments where id = $1', [late.id]))
        .toEqual({ status: 'cancelled', cancellation_actor: 'system', cancellation_reason: 'not_confirmed_in_time' });
      expect(await one(db, 'select status::text from public.appointments where id = $1', [kept.id])).toEqual({ status: 'confirmed' });
    });
  });
});
