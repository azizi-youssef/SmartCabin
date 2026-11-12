import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { APPOINTMENT_STATUSES, availableActions } from '@/modules/appointments/domain/status';

import { actAs, asPostgres, asUser, createPool, failure, one, withRollback, type Db } from './helpers/db';
import { createUser, createWorld, localInstant, type World } from './helpers/fixtures';

/**
 * Quality and security audit (2026-11-11) — adversarial checks that the earlier suites did
 * not cover: invitation revocation, suspension versus invitations, concurrent commands on
 * existing appointments, optimistic versioning, and UI/database transition parity.
 */
let pool: pg.Pool;
beforeAll(() => {
  pool = createPool(8);
});
afterAll(async () => {
  await pool.end();
});

async function scenario(fn: (db: Db, w: World) => Promise<void>): Promise<void> {
  await withRollback(pool, async (db) => fn(db, await createWorld(db)));
}

async function invite(db: Db, clinic: string, email: string, role: string): Promise<{ id: string; token: string }> {
  const row = await one<{ invitation_id: string; invitation_token: string }>(
    db, 'select * from public.invite_member($1, $2, $3)', [clinic, email, role]);
  return { id: row.invitation_id, token: row.invitation_token };
}

describe('revoke_invitation', () => {
  it('enforces permission, clinic scope and the admin role limit, and kills the token', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      const futureAdmin = await createUser(db);
      const futureReceptionist = await createUser(db);

      await actAs(db, asUser(w.users.ownerA));
      const adminInvite = await invite(db, w.clinicA, `${futureAdmin}@example.test`, 'clinic_admin');
      const receptionInvite = await invite(db, w.clinicA, `${futureReceptionist}@example.test`, 'receptionist');

      await actAs(db, asUser(w.users.adminA));
      expect((await failure(db, 'select public.revoke_invitation($1)', [adminInvite.id])).message).toBe('FORBIDDEN');
      await actAs(db, asUser(w.users.receptionA));
      expect((await failure(db, 'select public.revoke_invitation($1)', [receptionInvite.id])).message).toBe('FORBIDDEN');
      await actAs(db, asUser(w.users.ownerB));
      expect((await failure(db, 'select public.revoke_invitation($1)', [receptionInvite.id])).message).toBe('NOT_FOUND');

      await actAs(db, asUser(w.users.adminA));
      await db.query('select public.revoke_invitation($1)', [receptionInvite.id]);
      expect((await failure(db, 'select public.revoke_invitation($1)', [receptionInvite.id])).message).toBe('INVITATION_INVALID');

      await actAs(db, asUser(futureReceptionist));
      expect((await failure(db, 'select public.accept_invitation($1)', [receptionInvite.token])).message).toBe('INVITATION_INVALID');
    });
  });
});

describe('suspension versus invitations', () => {
  /**
   * AUDIT FINDING SC-AUD-03 (MEDIUM), fixed by migration 0031.
   * Admins may not manage owners or admins (set_member_status, change_member_role). An admin used
   * to be able to invite the e-mail of a SUSPENDED admin as a receptionist: on acceptance,
   * accept_invitation's ON CONFLICT reactivated the membership with the new role.
   */
  it('does not let an admin lift a suspension of an admin through a new invitation', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      const suspendedAdmin = await createUser(db);
      await db.query(
        `insert into public.clinic_members (clinic_id, user_id, role, status) values ($1, $2, 'clinic_admin', 'suspended')`,
        [w.clinicA, suspendedAdmin]);

      await actAs(db, asUser(w.users.adminA));
      // Direct reactivation is refused, as designed:
      const member = await one<{ id: string }>(db,
        'select id from public.clinic_members where clinic_id = $1 and user_id = $2', [w.clinicA, suspendedAdmin]);
      expect((await failure(db, `select public.set_member_status($1, 'active')`, [member.id])).message).toBe('FORBIDDEN');

      // The invitation path is refused too, at invitation already.
      expect((await failure(db, "select * from public.invite_member($1, $2, 'receptionist')", [w.clinicA, `${suspendedAdmin}@example.test`])).message)
        .toBe('MEMBER_SUSPENDED');
      let refused = false;
      try {
        await db.query('savepoint inv');
        const inv = await invite(db, w.clinicA, `${suspendedAdmin}@example.test`, 'receptionist');
        await actAs(db, asUser(suspendedAdmin));
        await db.query('select public.accept_invitation($1)', [inv.token]);
        await db.query('release savepoint inv');
      } catch {
        await db.query('rollback to savepoint inv');
        refused = true;
      }
      await actAs(db, asPostgres);
      const after = await one<{ role: string; status: string }>(db,
        'select role, status from public.clinic_members where clinic_id = $1 and user_id = $2', [w.clinicA, suspendedAdmin]);
      expect(refused).toBe(true);
      expect(after).toEqual({ role: 'clinic_admin', status: 'suspended' });
    });
  });

  it('refuses at acceptance a suspension decided after the invitation, and still lets a removed member come back', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      const [late, back] = [await createUser(db), await createUser(db)];
      await db.query(
        `insert into public.clinic_members (clinic_id, user_id, role, status) values ($1, $2, 'receptionist', 'removed'), ($1, $3, 'receptionist', 'removed')`,
        [w.clinicA, late, back]);

      await actAs(db, asUser(w.users.ownerA));
      const lateInvite = await invite(db, w.clinicA, `${late}@example.test`, 'receptionist');
      const backInvite = await invite(db, w.clinicA, `${back}@example.test`, 'receptionist');

      // Between the invitation and its acceptance, the owner suspends the person.
      await actAs(db, asPostgres);
      await db.query("update public.clinic_members set status = 'suspended' where clinic_id = $1 and user_id = $2", [w.clinicA, late]);
      await actAs(db, asUser(late));
      expect((await failure(db, 'select public.accept_invitation($1)', [lateInvite.token])).message).toBe('MEMBER_SUSPENDED');

      await actAs(db, asUser(back));
      await db.query('select public.accept_invitation($1)', [backInvite.token]);
      await actAs(db, asPostgres);
      expect((await db.query<{ user_id: string; status: string }>(
        'select user_id, status::text from public.clinic_members where clinic_id = $1 and user_id = any($2::uuid[]) order by status',
        [w.clinicA, [late, back]])).rows).toEqual([{ user_id: back, status: 'active' }, { user_id: late, status: 'suspended' }]);
    });
  });
});

// ---------------------------------------------------------------------------------------
// Concurrent commands on existing appointments (committed fixture, independent connections)
// ---------------------------------------------------------------------------------------

type Outcome<T> = { ok: true; value: T } | { ok: false; message: string };

function gate(): { open: () => void; barrier: Promise<void> } {
  let open = (): void => undefined;
  const barrier = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, barrier };
}

async function inOwnTransaction<T>(userId: string, barrier: Promise<void>, fn: (db: Db) => Promise<T>): Promise<Outcome<T>> {
  const db = await pool.connect();
  try {
    await db.query('begin');
    await actAs(db, asUser(userId));
    await barrier;
    const value = await fn(db);
    await db.query('commit');
    return { ok: true, value };
  } catch (error) {
    await db.query('rollback');
    return { ok: false, message: (error as Error).message };
  } finally {
    db.release();
  }
}

describe('concurrent commands on existing appointments', () => {
  let w: World;
  let at: (time: string) => Promise<string>;

  beforeAll(async () => {
    const db = await pool.connect();
    try {
      await db.query('begin');
      w = await createWorld(db);
      await db.query('commit');
    } finally {
      db.release();
    }
    at = async (time) => {
      const c = await pool.connect();
      try {
        return await localInstant(c, w.day, time);
      } finally {
        c.release();
      }
    };
  });

  async function book(time: string, patient: string): Promise<{ id: string; version: number }> {
    const db = await pool.connect();
    try {
      await db.query('begin');
      await actAs(db, asUser(w.users.receptionA));
      const row = await one<{ id: string; version: number }>(db,
        'select id, version from public.book_appointment($1, $2, $3, $4, null)',
        [patient, w.doctorA1, w.serviceA, await localInstant(db, w.day, time)]);
      await db.query('commit');
      return row;
    } catch (error) {
      await db.query('rollback');
      throw error;
    } finally {
      db.release();
    }
  }

  it('lets only one of two appointments be moved into the same free slot at the same time', async () => {
    const first = await book('10:00', w.patientA1);
    const second = await book('10:40', w.patientA2);
    const target = await at('15:20'); // doctorA1 is on time off from 16:00
    const g = gate();
    const runs = [first, second].map((a) => inOwnTransaction(w.users.receptionA, g.barrier, (db) =>
      one(db, 'select id from public.reschedule_appointment($1, $2)', [a.id, target])));
    g.open();
    const outcomes = await Promise.all(runs);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok).map((o) => (o as { message: string }).message)).toEqual(['SLOT_UNAVAILABLE']);
  });

  it('serializes confirm and cancel on one appointment into a valid final state', async () => {
    for (let round = 0; round < 4; round++) {
      const appt = await book(['11:00', '11:30', '12:00', '12:30'][round] ?? '11:00', w.patientA1);
      const g = gate();
      const confirm = inOwnTransaction(w.users.receptionA, g.barrier, (db) =>
        one(db, 'select status from public.confirm_appointment($1)', [appt.id]));
      const cancel = inOwnTransaction(w.users.receptionA, g.barrier, (db) =>
        one(db, `select status from public.cancel_appointment($1, 'patient_request')`, [appt.id]));
      g.open();
      const [c1, c2] = await Promise.all([confirm, cancel]);
      expect(c2.ok).toBe(true); // cancel is valid from pending and from confirmed
      if (!c1.ok) expect(c1.message).toBe('APPT_INVALID_TRANSITION');

      const db = await pool.connect();
      try {
        const final = await one<{ status: string }>(db, 'select status from public.appointments where id = $1', [appt.id]);
        expect(final.status).toBe('cancelled');
        const history = await one<{ n: number }>(db,
          `select count(*)::int as n from public.appointment_history where appointment_id = $1 and event_type = 'status_changed'`, [appt.id]);
        expect(history.n).toBe(c1.ok ? 2 : 1);
      } finally {
        db.release();
      }
    }
  });

  it('rejects the second of two edits made from the same version (STALE_STATE)', async () => {
    const appt = await book('13:00', w.patientA2);
    const [a, b] = [await at('13:40'), await at('14:20')];
    const g = gate();
    const runs = [a, b].map((target) => inOwnTransaction(w.users.receptionA, g.barrier, (db) =>
      one(db, 'select id from public.reschedule_appointment($1, $2, $3)', [appt.id, target, appt.version])));
    g.open();
    const outcomes = await Promise.all(runs);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok).map((o) => (o as { message: string }).message)).toEqual(['STALE_STATE']);
  });
});

describe('UI actions versus database transitions', () => {
  it('never offers an action that the database transition table refuses', async () => {
    await withRollback(pool, async (db) => {
      await actAs(db, asPostgres);
      const allowed = new Set((await db.query<{ t: string }>(
        `select from_status || '>' || to_status as t from public.appointment_status_transitions`)).rows.map((r) => r.t));
      const longAfterStart = new Date('2030-01-01T12:00:00Z');
      for (const status of APPOINTMENT_STATUSES) {
        const offered = availableActions({ status, startsAt: '2030-01-01T08:00:00Z' }, longAfterStart, 15);
        if (offered.confirm) expect(allowed.has(`${status}>confirmed`), `${status} confirm`).toBe(true);
        if (offered.cancel) expect(allowed.has(`${status}>cancelled`), `${status} cancel`).toBe(true);
        if (offered.noShow) expect(allowed.has(`${status}>no_show`), `${status} no-show`).toBe(true);
        // reschedule_appointment and appointments_guard accept pending and confirmed only.
        expect(offered.reschedule, `${status} reschedule`).toBe(status === 'pending' || status === 'confirmed');
      }
    });
  });
});
