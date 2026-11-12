import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { actAs, asPostgres, asUser, count, createPool, failure, one, withRollback, type Db } from './helpers/db';
import { createWorld, localInstant, type World } from './helpers/fixtures';

/**
 * Module 12 — SaaS administration (migration 0029): subscriptions and their lifecycle
 * (BUSINESS_RULES §7), read-only clinics on expiry (BR-P-01), plan limits (BR-T-08, BR-N-08),
 * platform functions guarded for platform admins with MFA, counts only (RBAC §4).
 */
let pool: pg.Pool;
beforeAll(() => {
  pool = createPool(3);
});
afterAll(async () => {
  await pool.end();
});

async function scenario(fn: (db: Db, w: World) => Promise<void>): Promise<void> {
  await withRollback(pool, async (db) => fn(db, await createWorld(db)));
}

async function localToday(db: Db, offset = 0): Promise<string> {
  return (await one<{ d: string }>(db, "select ((now() at time zone 'Africa/Casablanca')::date + $1::int)::text as d", [offset])).d;
}

async function savePlan(db: Db, w: World, code: string, limits: Record<string, number | null>, graceDays = 7): Promise<string> {
  await actAs(db, asUser(w.users.platformAdmin));
  return (await one<{ id: string }>(db,
    "select public.platform_save_plan(null, $1, 'Formule ' || $1, 'باقة ' || $1, 300, $2, true, true, $3::jsonb) as id",
    [code, graceDays, JSON.stringify(limits)])).id;
}

async function setSubscription(db: Db, w: World, clinic: string, plan: string, status: string, from: string | null, to: string | null, trialEnd: string | null = null) {
  await actAs(db, asUser(w.users.platformAdmin));
  return db.query('select public.platform_set_subscription($1, $2, $3::public.subscription_status, $4::date, $5::date, $6::date)', [clinic, plan, status, from, to, trialEnd]);
}

async function subscriptionOf(db: Db, clinic: string) {
  await actAs(db, asPostgres);
  return one<{ status: string; plan: string }>(db,
    `select s.status::text, p.code as plan from public.subscriptions s join public.subscription_plans p on p.id = s.plan_id
     where s.clinic_id = $1 order by (s.status <> 'expired') desc, s.started_at desc limit 1`, [clinic]);
}

describe('subscriptions (BUSINESS_RULES §7)', () => {
  it('starts every clinic on a pilot trial, shown to owner, admin and accountant only', async () => {
    await scenario(async (db, w) => {
      expect(await subscriptionOf(db, w.clinicA)).toEqual({ status: 'trialing', plan: 'pilot' });
      await actAs(db, asUser(w.users.accountantA));
      expect(await one(db, 'select plan_code, status::text, limits, usage, read_only_reason from public.get_my_subscription($1)', [w.clinicA])).toEqual({
        plan_code: 'pilot',
        status: 'trialing',
        limits: { max_doctors: null, max_staff: null, monthly_sms_quota: null },
        usage: { max_doctors: 2, max_staff: 5, monthly_sms_quota: 0 }, // suspended members do not count
        read_only_reason: null,
      });
      for (const who of [w.users.receptionA, w.users.doctorA]) {
        await actAs(db, asUser(who));
        expect((await failure(db, 'select * from public.get_my_subscription($1)', [w.clinicA])).message).toBe('FORBIDDEN');
        expect(await count(db, 'select 1 from public.subscriptions where clinic_id = $1', [w.clinicA])).toBe(0);
      }
      await actAs(db, asUser(w.users.ownerB));
      expect((await failure(db, 'select * from public.get_my_subscription($1)', [w.clinicA])).message).toBe('NOT_FOUND');
    });
  });

  it('moves subscriptions through their lifecycle, with the plan grace days, and records payments', async () => {
    await scenario(async (db, w) => {
      await savePlan(db, w, 'small', { max_doctors: 5 }, 7);
      const [d40, d10, d2, d30] = [await localToday(db, -40), await localToday(db, -10), await localToday(db, -2), await localToday(db, 30)];
      await setSubscription(db, w, w.clinicA, 'small', 'active', d40, d10); // ended 10 days ago: beyond 7 days of grace
      await setSubscription(db, w, w.clinicB, 'small', 'active', d40, d2); // ended 2 days ago: in grace
      await actAs(db, asPostgres);
      await db.query('select private.refresh_subscription_states()');
      expect(await subscriptionOf(db, w.clinicA)).toEqual({ status: 'expired', plan: 'small' });
      expect(await subscriptionOf(db, w.clinicB)).toEqual({ status: 'past_due', plan: 'small' });

      await actAs(db, asUser(w.users.platformAdmin));
      expect((await failure(db, "select public.platform_set_subscription($1, 'small', 'past_due', $2::date, $3::date)", [w.clinicA, d40, d30])).message)
        .toBe('SUBSCRIPTION_INVALID_TRANSITION');
      expect((await failure(db, "select public.platform_set_subscription($1, 'small', 'active')", [w.clinicB])).message).toBe('VALIDATION_FAILED');
      await db.query('select public.platform_mark_subscription_paid($1, $2::date)', [w.clinicB, d30]);
      expect(await subscriptionOf(db, w.clinicB)).toEqual({ status: 'active', plan: 'small' });
      await actAs(db, asPostgres);
      expect(await one(db, "select ((current_period_end at time zone 'Africa/Casablanca')::date - 1)::text as until from public.subscriptions where clinic_id = $1 and status = 'active'", [w.clinicB]))
        .toEqual({ until: d30 });
      expect((await db.query("select action from public.audit_logs where entity_type = 'subscriptions' and clinic_id = $1", [w.clinicB])).rows.length).toBeGreaterThanOrEqual(3);

      // A trial with an end date expires on its own too.
      await setSubscription(db, w, w.clinicB, 'small', 'cancelled', d40, d2);
      await actAs(db, asPostgres);
      await db.query('select private.refresh_subscription_states()');
      expect(await subscriptionOf(db, w.clinicB)).toEqual({ status: 'expired', plan: 'small' });
    });
  });

  it('makes a clinic read-only when its subscription expires; the owner can still ask for a plan (BR-P-01)', async () => {
    await scenario(async (db, w) => {
      await savePlan(db, w, 'small', {});
      await setSubscription(db, w, w.clinicA, 'pilot', 'trialing', null, null, await localToday(db, -1));
      await actAs(db, asPostgres);
      await db.query('select private.refresh_subscription_states()');

      await actAs(db, asUser(w.users.ownerA));
      const access = await one<{ permissions: string[]; read_only_reason: string }>(db, 'select * from public.get_my_clinic_access($1)', [w.clinicA]);
      expect(access.read_only_reason).toBe('subscription_expired');
      expect(access.permissions).toContain('appointments.view');
      expect(access.permissions).toContain('subscription.request_change');
      expect(access.permissions).not.toContain('appointments.book');
      expect(await count(db, 'select 1 from public.appointments where clinic_id = $1', [w.clinicA])).toBe(2);
      const startsAt = await localInstant(db, w.day, '11:00');
      expect((await failure(db, 'select public.book_appointment($1, $2, $3, $4)', [w.patientA2, w.doctorA1, w.serviceA, startsAt])).message).toBe('FORBIDDEN');
      expect((await failure(db, "insert into public.doctors (clinic_id, full_name) values ($1, 'Dr New')", [w.clinicA])).code).toBe('42501');
      await db.query("select public.request_plan_change($1, 'small', 'Merci de réactiver')", [w.clinicA]);
      expect((await failure(db, "select public.request_plan_change($1, 'pilot')", [w.clinicA])).message).toBe('VALIDATION_FAILED'); // not public

      await actAs(db, asUser(w.users.receptionA));
      expect(await count(db, 'select 1 from public.appointments where clinic_id = $1', [w.clinicA])).toBe(2);

      // The platform answers the request: a new subscription starts and writes come back.
      await setSubscription(db, w, w.clinicA, 'small', 'active', await localToday(db), await localToday(db, 30));
      await actAs(db, asUser(w.users.ownerA));
      expect((await one<{ read_only_reason: string | null }>(db, 'select * from public.get_my_clinic_access($1)', [w.clinicA])).read_only_reason).toBeNull();
      expect(await one(db, 'select plan_code, status::text, open_request_plan_code from public.get_my_subscription($1)', [w.clinicA]))
        .toEqual({ plan_code: 'small', status: 'active', open_request_plan_code: null });
      await db.query('select public.book_appointment($1, $2, $3, $4)', [w.patientA2, w.doctorA1, w.serviceA, startsAt]);
      await actAs(db, asPostgres);
      expect(await count(db,
        `select 1 from public.subscription_change_requests r join public.subscription_plans p on p.id = r.plan_id
         where r.clinic_id = $1 and r.status = 'handled' and p.code = 'small'`, [w.clinicA])).toBe(1);
    });
  });
});

describe('plan limits (BR-T-08)', () => {
  it('refuses a doctor, a member or an invitation beyond the plan, for postgres too', async () => {
    await scenario(async (db, w) => {
      await savePlan(db, w, 'small', { max_doctors: 2, max_staff: 5 });
      await setSubscription(db, w, w.clinicA, 'small', 'active', await localToday(db), await localToday(db, 30));

      await actAs(db, asUser(w.users.ownerA));
      const insertDoctor = "insert into public.doctors (clinic_id, full_name) values ($1, 'Doctor A3')";
      expect(await failure(db, insertDoctor, [w.clinicA])).toMatchObject({ message: 'PLAN_LIMIT_REACHED', detail: 'max_doctors' });
      await db.query("update public.doctors set status = 'inactive' where id = $1", [w.doctorA2]);
      await db.query(insertDoctor, [w.clinicA]);
      expect(await failure(db, "update public.doctors set status = 'active' where id = $1", [w.doctorA2])).toMatchObject({ message: 'PLAN_LIMIT_REACHED' });

      expect(await failure(db, "select * from public.invite_member($1, 'new.member@example.test', 'receptionist')", [w.clinicA]))
        .toMatchObject({ message: 'PLAN_LIMIT_REACHED', detail: 'max_staff' });
      await actAs(db, asPostgres);
      expect(await failure(db, "update public.clinic_members set status = 'active' where user_id = $1 and clinic_id = $2", [w.users.suspendedA, w.clinicA]))
        .toMatchObject({ message: 'PLAN_LIMIT_REACHED', detail: 'max_staff' });

      // Clinic B stays on the unlimited pilot plan.
      await actAs(db, asUser(w.users.ownerB));
      await db.query("insert into public.doctors (clinic_id, full_name) values ($1, 'Doctor B2')", [w.clinicB]);
    });
  });

  it('lets only one of two concurrent additions take the last seat', async () => {
    const setup = await pool.connect();
    let w: World;
    try {
      await setup.query('begin');
      w = await createWorld(setup);
      // Committed: a code of its own, so reruns never collide.
      const code = `seats_${Date.now().toString(36)}`;
      await savePlan(setup, w, code, { max_doctors: 3 });
      await setSubscription(setup, w, w.clinicA, code, 'active', await localToday(setup), await localToday(setup, 30));
      await setup.query('commit');
    } catch (error) {
      await setup.query('rollback');
      throw error;
    } finally {
      setup.release();
    }
    const add = async (name: string) => {
      const db = await pool.connect();
      try {
        await db.query('begin');
        await actAs(db, asUser(w.users.ownerA));
        try {
          await db.query('insert into public.doctors (clinic_id, full_name) values ($1, $2)', [w.clinicA, name]);
          await db.query('commit');
          return 'ok';
        } catch (error) {
          await db.query('rollback');
          return (error as Error).message;
        }
      } finally {
        db.release();
      }
    };
    expect((await Promise.all([add('Doctor X'), add('Doctor Y')])).sort()).toEqual(['PLAN_LIMIT_REACHED', 'ok']);
  });

  it('does not send SMS beyond the monthly quota (BR-N-08)', async () => {
    await scenario(async (db, w) => {
      const jobKey = 'subscription-test-job-key-'.padEnd(48, 'k');
      await actAs(db, asPostgres);
      await db.query("select private.set_job_key_hash(encode(extensions.digest($1, 'sha256'), 'hex'))", [jobKey]);
      await db.query(
        `insert into public.patient_consents (clinic_id, patient_id, purpose, granted, document_version, source)
         values ($1, $2, 'reminders_sms', true, 'v1', 'reception')`, [w.clinicA, w.patientA1]);
      const { starts_at: startsAt } = await one<{ starts_at: string }>(db, 'select starts_at::text from public.appointments where id = $1', [w.apptA1]);
      const notify = (key: string, status = 'scheduled') => db.query(
        `insert into public.notifications (clinic_id, patient_id, appointment_id, event_type, channel, locale, scheduled_for, context_starts_at,
                                           status, sent_at, idempotency_key)
         values ($1, $2, $3, 'appointment_confirmation', 'sms', 'fr', now() - interval '1 minute', $4::timestamptz,
                 $5::public.notification_status, case when $5 = 'sent' then now() end, $6)`,
        [w.clinicA, w.patientA1, w.apptA1, startsAt, status, key]);
      await savePlan(db, w, 'small', { monthly_sms_quota: 1 });
      await setSubscription(db, w, w.clinicA, 'small', 'active', await localToday(db), await localToday(db, 30));

      await actAs(db, asPostgres);
      await notify('quota-test:sent', 'sent'); // the month's only allowed SMS is already sent
      await notify('quota-test:due');
      await db.query("select set_config('role', 'anon', true)");
      expect((await db.query('select * from public.jobs_claim_notifications($1)', [jobKey])).rows).toEqual([]);
      await actAs(db, asPostgres);
      expect(await one(db, "select status::text, skip_reason from public.notifications where idempotency_key = 'quota-test:due'"))
        .toEqual({ status: 'skipped', skip_reason: 'quota_exceeded' });
    });
  });
});

describe('platform administration (RBAC §4)', () => {
  it('serves platform functions only to a platform admin with MFA, with counts and never patient rows', async () => {
    await scenario(async (db, w) => {
      const calls = [
        'select * from public.platform_list_plans()',
        'select * from public.platform_kpi_overview()',
        "select public.platform_save_plan(null, 'x_plan', 'Plan X', 'باقة X', 0, 7, true, true, '{}'::jsonb)",
        `select public.platform_set_subscription('${w.clinicA}', 'pilot', 'trialing')`,
        `select public.platform_mark_subscription_paid('${w.clinicA}', current_date + 30)`,
      ];
      for (const [who, aal] of [[w.users.ownerA, 'aal2'], [w.users.outsider, 'aal2'], [w.users.platformAdmin, 'aal1']] as const) {
        await actAs(db, asUser(who, aal));
        for (const sql of calls) expect((await failure(db, sql)).message, `${who} ${sql}`).toBe('FORBIDDEN');
      }

      await actAs(db, asUser(w.users.platformAdmin));
      const overview = await db.query('select * from public.platform_kpi_overview() where clinic_id = $1', [w.clinicA]);
      expect(overview.fields.map((f) => f.name).sort()).toEqual([
        'active_doctors', 'active_members', 'appointments_30d', 'clinic_id', 'completed_30d', 'current_period_end', 'online_bookings_30d',
        'open_request_plan_code', 'patients_total', 'plan_code', 'plan_name_ar', 'plan_name_fr', 'sms_this_month', 'subscription_status', 'trial_ends_at',
      ]);
      expect(overview.rows[0]).toMatchObject({ plan_code: 'pilot', subscription_status: 'trialing', active_members: 5, active_doctors: 2, patients_total: 2 });
      for (const table of ['patients', 'appointments', 'invoices', 'notifications', 'subscriptions']) {
        expect(await count(db, `select 1 from public.${table} where clinic_id = $1`, [w.clinicA]), table).toBe(0);
      }

      const save = 'select public.platform_save_plan(null, $1, $2, $3, 100, 7, true, true, $4::jsonb)';
      for (const [code, limits] of [['Bad Code', '{}'], ['ok_code', '{"max_patients": 3}'], ['ok_code', '{"max_staff": 0}'], ['ok_code', '{"max_doctors": 1.5}']]) {
        expect((await failure(db, save, [code, 'Formule', 'باقة', limits])).message, `${code} ${limits}`).toBe('VALIDATION_FAILED');
      }
      await db.query(save, ['dup_code', 'Formule', 'باقة', '{}']);
      expect((await failure(db, save, ['dup_code', 'Formule', 'باقة', '{}'])).message).toBe('DUPLICATE');
      const plans = (await db.query<{ code: string; live_subscriptions: number }>('select code, live_subscriptions from public.platform_list_plans()')).rows;
      expect(plans.find((p) => p.code === 'pilot')?.live_subscriptions).toBeGreaterThanOrEqual(2);
    });
  });
});
