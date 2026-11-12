import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { actAs, asAnon, asPostgres, asUser, count, createPool, failure, one, withRollback, type Db } from './helpers/db';
import { createWorld, localInstant, type World } from './helpers/fixtures';
import { signJob, verifyJobSignature } from '../../src/modules/notifications/hmac';

/**
 * Module 9 — notifications (migration 0026): planning from the outbox (BR-N-01/03/07/09, BR-Q-11,
 * §3.2-5), dispatch checks right before sending (BR-N-02/04), templates (BR-N-05), retries
 * (BR-N-06), leases, the job key, and who may see the message log.
 */
const JOB_KEY = 'test-job-key-'.padEnd(48, 'k');
let pool: pg.Pool;
beforeAll(() => {
  pool = createPool(4);
});
afterAll(async () => {
  await pool.end();
});

async function withJobKey(db: Db): Promise<void> {
  await actAs(db, asPostgres);
  await db.query("select private.set_job_key_hash(encode(extensions.digest($1, 'sha256'), 'hex'))", [JOB_KEY]);
}

async function scenario(fn: (db: Db, w: World) => Promise<void>): Promise<void> {
  await withRollback(pool, async (db) => {
    const w = await createWorld(db);
    await withJobKey(db);
    await fn(db, w);
  });
}

async function plan(db: Db): Promise<void> {
  await actAs(db, asPostgres);
  await db.query('select private.plan_notifications()');
}

async function consent(db: Db, w: World, patient: string, purpose: string, granted = true): Promise<void> {
  await actAs(db, asPostgres);
  await db.query(
    `insert into public.patient_consents (clinic_id, patient_id, purpose, granted, document_version, source)
     values ($1, $2, $3, $4, 'v1', 'reception')`, [w.clinicA, patient, purpose, granted]);
}

async function book(db: Db, w: World, patient: string, time: string): Promise<string> {
  await actAs(db, asUser(w.users.receptionA));
  return (await one<{ id: string }>(db, 'select id from public.book_appointment($1, $2, $3, $4)',
    [patient, w.doctorA1, w.serviceA, await localInstant(db, w.day, time)])).id;
}

interface Row {
  event_type: string;
  status: string;
  skip_reason: string | null;
  scheduled_for: string;
}

async function messagesOf(db: Db, appointment: string): Promise<Row[]> {
  await actAs(db, asPostgres);
  return (await db.query<Row>(
    `select event_type::text, status::text, skip_reason, scheduled_for::text from public.notifications
     where appointment_id = $1 order by event_type, scheduled_for`, [appointment])).rows;
}

async function makeDue(db: Db, appointment?: string): Promise<void> {
  await actAs(db, asPostgres);
  await db.query(`update public.notifications set scheduled_for = now() - interval '1 second'
                  where status = 'scheduled' and ($1::uuid is null or appointment_id = $1)`, [appointment ?? null]);
}

interface Claimed {
  notification_id: string;
  channel: string;
  recipient: string;
  subject: string | null;
  body: string;
  attempt_no: number;
}

async function claim(db: Db, limit = 50): Promise<Claimed[]> {
  await actAs(db, asAnon);
  return (await db.query<Claimed>('select * from public.jobs_claim_notifications($1, $2)', [JOB_KEY, limit])).rows;
}

async function record(db: Db, id: string, outcome: string, retryable = false): Promise<string> {
  await actAs(db, asAnon);
  return (await one<{ s: string }>(db, 'select public.jobs_record_attempt($1, $2, $3, $4, $5, $6, $7)::text as s',
    [JOB_KEY, id, outcome, 'simulator', outcome === 'accepted' ? 'sim-1' : null, outcome === 'accepted' ? null : 'E_TEST', retryable])).s;
}

describe('planning (BR-N-01, BR-N-07, BR-N-09)', () => {
  it('plans a confirmation and the reminders once, moving or skipping those in quiet hours', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      await db.query("update public.clinic_settings set reminder_offsets_minutes = '{1440,30}' where clinic_id = $1", [w.clinicA]);
      const appt = await book(db, w, w.patientA1, '08:00');
      await plan(db);
      await plan(db); // re-planning the same events creates nothing new
      const rows = await messagesOf(db, appt);
      expect(rows.map((r) => [r.event_type, r.status, r.skip_reason])).toEqual([
        ['appointment_confirmation', 'scheduled', null],
        ['appointment_reminder', 'scheduled', null], // 24 h before: 08:00 the day before
        ['appointment_reminder', 'skipped', 'quiet_hours'], // 30 min before is 07:30: moved to 08:00 = the appointment itself
      ]);
      const expected = await localInstant(db, w.day, '08:00', -1);
      expect(rows[1]?.scheduled_for).toBe(new Date(expected).toISOString().replace('T', ' ').replace('.000Z', '+00'));
      expect(await count(db, 'select 1 from public.domain_events where aggregate_id = $1 and processed_at is null', [appt])).toBe(0);
    });
  });

  it('cancels what is scheduled on reschedule and cancellation, and plans the right messages again (BR-N-03)', async () => {
    await scenario(async (db, w) => {
      const appt = await book(db, w, w.patientA1, '10:00');
      await plan(db);
      await actAs(db, asUser(w.users.receptionA));
      await db.query('select public.reschedule_appointment($1, $2)', [appt, await localInstant(db, w.day, '11:00')]);
      await plan(db);
      expect((await messagesOf(db, appt)).map((r) => [r.event_type, r.status])).toEqual([
        ['appointment_confirmation', 'cancelled'],
        ['appointment_reminder', 'cancelled'],
        ['appointment_reminder', 'scheduled'],
        ['appointment_rescheduled', 'scheduled'],
      ]);

      await actAs(db, asUser(w.users.receptionA));
      await db.query("select public.cancel_appointment($1, 'patient_request')", [appt]);
      await plan(db);
      const after = await messagesOf(db, appt);
      expect(after.filter((r) => r.status === 'scheduled').map((r) => r.event_type)).toEqual(['appointment_cancellation']);
    });
  });

  it('sends no cancellation message when the patient left the waiting room', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      const walkIn = await one<{ appointment_id: string; queue_entry_id: string }>(db,
        'select * from public.register_walk_in($1, $2, $3)', [w.patientA1, w.doctorA1, w.serviceA]);
      await db.query('select public.mark_left($1)', [walkIn.queue_entry_id]);
      await plan(db);
      expect((await messagesOf(db, walkIn.appointment_id)).filter((r) => r.event_type === 'appointment_cancellation')).toEqual([]);
    });
  });

  it('plans "turn approaching" once per ticket at the configured position, and delay messages (BR-Q-11)', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      const entries = [];
      for (const p of [w.patientA1, w.patientA2, w.patientA1]) {
        entries.push(await one<{ appointment_id: string; queue_entry_id: string }>(db,
          'select * from public.register_walk_in($1, $2, $3)', [p, w.doctorA1, w.serviceA]));
      }
      await plan(db);
      await plan(db);
      await actAs(db, asPostgres);
      const turns = (await db.query<{ queue_entry_id: string }>(
        "select queue_entry_id from public.notifications where event_type = 'turn_approaching' and clinic_id = $1", [w.clinicA])).rows;
      expect(turns.map((r) => r.queue_entry_id).sort()).toEqual([entries[0]?.queue_entry_id, entries[1]?.queue_entry_id].sort());

      await actAs(db, asUser(w.users.ownerA));
      await db.query('select public.report_doctor_delay($1, 30)', [w.doctorA1]);
      await plan(db);
      expect(await count(db, "select 1 from public.notifications where event_type = 'doctor_delay' and delay_minutes = 30 and clinic_id = $1",
        [w.clinicA])).toBe(3);
    });
  });
});

describe('dispatch (BR-N-02, BR-N-04, BR-N-05)', () => {
  it('re-checks right before sending: never a reminder after a cancellation', async () => {
    await scenario(async (db, w) => {
      await consent(db, w, w.patientA1, 'reminders_sms');
      const appt = await book(db, w, w.patientA1, '10:00');
      await plan(db);
      // Cancelled before the planner runs again: the reminder is still "scheduled".
      await actAs(db, asUser(w.users.receptionA));
      await db.query("select public.cancel_appointment($1, 'patient_request')", [appt]);
      await makeDue(db, appt);
      const claimed = await claim(db);
      expect(claimed).toEqual([]);
      expect((await messagesOf(db, appt)).map((r) => [r.event_type, r.status, r.skip_reason])).toEqual([
        ['appointment_confirmation', 'skipped', 'stale'],
        ['appointment_reminder', 'skipped', 'stale'],
      ]);
    });
  });

  it('sends only with consent and an address, in the patient locale, with no clinical detail', async () => {
    await scenario(async (db, w) => {
      await consent(db, w, w.patientA1, 'reminders_sms');
      await actAs(db, asPostgres);
      await db.query("update public.patients set preferred_locale = 'ar' where id = $1", [w.patientA1]);
      const withConsent = await book(db, w, w.patientA1, '10:00');
      const without = await book(db, w, w.patientA2, '11:00');
      await plan(db);
      await actAs(db, asPostgres);
      await db.query("delete from public.notifications where event_type = 'appointment_reminder' and clinic_id = $1", [w.clinicA]);
      await makeDue(db);

      const claimed = await claim(db);
      expect(claimed).toHaveLength(1);
      const sms = claimed[0];
      expect(sms).toMatchObject({ channel: 'sms', recipient: '+99911111111', subject: null, attempt_no: 1 });
      expect(sms?.body).toContain('تم تأكيد موعدك');
      expect(sms?.body).toContain('10:00');
      for (const forbidden of ['Alice', 'Alpha', 'Consultation', 'P0000']) expect(sms?.body).not.toContain(forbidden);
      expect((await messagesOf(db, without))[0]).toMatchObject({ status: 'skipped', skip_reason: 'no_consent' });
      await actAs(db, asPostgres);
      expect(await one(db, 'select recipient_masked from public.notifications where appointment_id = $1', [withConsent]))
        .toEqual({ recipient_masked: '+9991•••••11' });

      // E-mail chosen and consented, but no address on file: skipped.
      await db.query("update public.patients set preferred_channel = 'email', email = null where id = $1", [w.patientA2]);
      await consent(db, w, w.patientA2, 'reminders_email');
      const noAddress = await book(db, w, w.patientA2, '12:00');
      await plan(db);
      await actAs(db, asPostgres);
      await db.query("delete from public.notifications where event_type = 'appointment_reminder' and appointment_id = $1", [noAddress]);
      await makeDue(db, noAddress);
      expect(await claim(db)).toEqual([]);
      expect((await messagesOf(db, noAddress))[0]).toMatchObject({ status: 'skipped', skip_reason: 'no_address' });
    });
  });

  it('rejects templates that use anything but the allowed placeholders', async () => {
    await scenario(async (db) => {
      await actAs(db, asPostgres);
      expect((await failure(db,
        `insert into public.notification_templates (event_type, channel, locale, version, body)
         values ('appointment_reminder', 'sms', 'fr', 2, '{clinic} : rappel pour {service} le {date}')`)).code).toBe('23514');
    });
  });
});

describe('retries, leases and the job key (BR-N-06)', () => {
  it('retries with backoff 1, 5, 15, 60 minutes, then fails at the fifth attempt; permanent errors fail at once', async () => {
    await scenario(async (db, w) => {
      await consent(db, w, w.patientA1, 'reminders_sms');
      const appt = await book(db, w, w.patientA1, '10:00');
      await plan(db);
      await actAs(db, asPostgres);
      await db.query("delete from public.notifications where event_type = 'appointment_reminder' and appointment_id = $1", [appt]);
      await makeDue(db, appt);

      const delays: number[] = [];
      for (let attempt = 1; attempt <= 5; attempt++) {
        const [message] = await claim(db);
        expect(message?.attempt_no).toBe(attempt);
        const status = await record(db, message?.notification_id ?? '', 'error', true);
        await actAs(db, asPostgres);
        const row = await one<{ minutes: number | null }>(db,
          'select round(extract(epoch from (next_attempt_at - now())) / 60)::int as minutes from public.notifications where id = $1',
          [message?.notification_id]);
        if (attempt < 5) {
          expect(status).toBe('scheduled');
          delays.push(row.minutes ?? -1);
          await db.query('update public.notifications set next_attempt_at = now() - interval $$1 second$$ where id = $1', [message?.notification_id]);
        } else {
          expect(status).toBe('failed');
        }
      }
      expect(delays).toEqual([1, 5, 15, 60]);
      expect(await count(db, 'select 1 from public.notification_attempts where clinic_id = $1', [w.clinicA])).toBe(5);
      expect((await failure(db, 'delete from public.notification_attempts where clinic_id = $1', [w.clinicA])).message).toBe('APPEND_ONLY');

      // A permanent rejection fails immediately; an accepted send is final, later reports are ignored.
      const second = await book(db, w, w.patientA1, '11:00');
      await plan(db);
      await actAs(db, asPostgres);
      await db.query("delete from public.notifications where event_type = 'appointment_reminder' and appointment_id = $1", [second]);
      await makeDue(db, second);
      const [m2] = await claim(db);
      expect(await record(db, m2?.notification_id ?? '', 'rejected')).toBe('failed');
      const third = await book(db, w, w.patientA1, '12:00');
      await plan(db);
      await actAs(db, asPostgres);
      await db.query("delete from public.notifications where event_type = 'appointment_reminder' and appointment_id = $1", [third]);
      await makeDue(db, third);
      const [m3] = await claim(db);
      expect(await record(db, m3?.notification_id ?? '', 'accepted')).toBe('sent');
      expect(await record(db, m3?.notification_id ?? '', 'error', true)).toBe('sent');
    });
  });

  it('records a timeout when a lease expires, and retries later', async () => {
    await scenario(async (db, w) => {
      await consent(db, w, w.patientA1, 'reminders_sms');
      const appt = await book(db, w, w.patientA1, '10:00');
      await plan(db);
      await actAs(db, asPostgres);
      await db.query("delete from public.notifications where event_type = 'appointment_reminder' and appointment_id = $1", [appt]);
      await makeDue(db, appt);
      const [first] = await claim(db);
      expect(await claim(db)).toEqual([]); // leased: nobody else gets it
      await actAs(db, asPostgres);
      await db.query("update public.notifications set locked_until = now() - interval '1 second' where id = $1", [first?.notification_id]);
      expect(await claim(db)).toEqual([]); // timed out, rescheduled after the backoff
      await actAs(db, asPostgres);
      expect(await one(db, "select outcome from public.notification_attempts where notification_id = $1", [first?.notification_id]))
        .toEqual({ outcome: 'timeout' });
      expect(await one(db, 'select status::text from public.notifications where id = $1', [first?.notification_id])).toEqual({ status: 'scheduled' });
    });
  });

  it('refuses every job function without the job key, and to signed-in users', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asAnon);
      for (const sql of [
        'select public.jobs_plan_notifications($1)',
        'select * from public.jobs_claim_notifications($1)',
        "select public.jobs_record_attempt($1, gen_random_uuid(), 'accepted', 'x')",
      ]) {
        expect((await failure(db, sql, ['wrong-key-'.padEnd(48, 'x')])).message).toBe('FORBIDDEN');
        expect((await failure(db, sql, [null])).message).toBe('FORBIDDEN');
      }
      await actAs(db, asUser(w.users.ownerA));
      expect((await failure(db, 'select public.jobs_plan_notifications($1)', [JOB_KEY])).code).toBe('42501');
    });
  });

  it('signs scheduled calls (private.call_dispatch) exactly as the endpoint verifies them', async () => {
    await withRollback(pool, async (db) => {
      const signed = await one<{ ts: string; sig: string }>(db,
        `select extract(epoch from now())::bigint::text as ts,
                encode(extensions.hmac(extract(epoch from now())::bigint::text || '.' || '{}', $1, 'sha256'), 'hex') as sig`, [JOB_KEY]);
      expect(signed.sig).toBe(signJob(JOB_KEY, signed.ts, '{}'));
      expect(verifyJobSignature({ secret: JOB_KEY, timestamp: signed.ts, signature: signed.sig, body: '{}' })).toBe(true);
    });
  });

  it('never lets two workers claim the same message', async () => {
    const setup = await pool.connect();
    let w: World;
    try {
      await setup.query('begin');
      w = await createWorld(setup);
      await withJobKey(setup);
      await consent(setup, w, w.patientA1, 'reminders_sms');
      // 10:00 to 15:00: the fixture's day has an appointment at 09:00 and time off from 16:00.
      for (let i = 0; i < 6; i++) await book(setup, w, w.patientA1, `${String(10 + i).padStart(2, '0')}:00`);
      await plan(setup);
      await makeDue(setup);
      await setup.query('commit');
    } catch (error) {
      await setup.query('rollback');
      throw error;
    } finally {
      setup.release();
    }
    const run = async () => {
      const db = await pool.connect();
      try {
        await db.query('begin');
        const rows = await claim(db, 20);
        await db.query('commit');
        return rows.map((r) => r.notification_id);
      } finally {
        db.release();
      }
    };
    const [a, b] = await Promise.all([run(), run()]);
    const all = [...a, ...b];
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeGreaterThan(0);
  });
});

describe('who sees the message log', () => {
  it("shows the clinic's front desk its messages, nobody else; templates stay internal", async () => {
    await scenario(async (db, w) => {
      const appt = await book(db, w, w.patientA1, '10:00');
      await plan(db);
      const visible = 'select 1 from public.notifications where appointment_id = $1';
      for (const user of [w.users.ownerA, w.users.adminA, w.users.receptionA]) {
        await actAs(db, asUser(user));
        expect(await count(db, visible, [appt]), user).toBeGreaterThan(0);
      }
      for (const user of [w.users.doctorA, w.users.accountantA, w.users.ownerB, w.users.patientAccount]) {
        await actAs(db, asUser(user));
        expect(await count(db, visible, [appt]), user).toBe(0);
      }
      await actAs(db, asUser(w.users.ownerA));
      expect((await failure(db, 'select 1 from public.notification_templates limit 1')).code).toBe('42501');
    });
  });
});
