import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { actAs, asAnon, asPostgres, asUser, count, createPool, failure, one, withRollback, type Db } from './helpers/db';
import { createWorld, type World } from './helpers/fixtures';

/**
 * Module 8b — SmartFlow live (migration 0025): realtime hints and topic authorization
 * (SECURITY_MODEL §5), waiting-room display screens, the portal queue status, end-of-day job.
 * Realtime runs against the shim's realtime.messages / realtime.topic() / realtime.send().
 */
let pool: pg.Pool;
beforeAll(() => {
  pool = createPool(2);
});
afterAll(async () => {
  await pool.end();
});

async function scenario(fn: (db: Db, w: World) => Promise<void>): Promise<void> {
  await withRollback(pool, async (db) => fn(db, await createWorld(db)));
}

async function walkIn(db: Db, w: World, patient: string, doctor: string = w.doctorA1): Promise<{ appointment_id: string; queue_entry_id: string; ticket_number: number }> {
  await actAs(db, asUser(w.users.receptionA));
  return one(db, 'select * from public.register_walk_in($1, $2, $3)', [patient, doctor, doctor === w.doctorA2 ? w.serviceA2 : w.serviceA]);
}

async function today(db: Db): Promise<string> {
  return (await one<{ d: string }>(db, "select ((now() at time zone 'Africa/Casablanca')::date)::text as d")).d;
}

/** Messages a user may receive on a topic, as Supabase Realtime authorizes private channels. */
async function receivable(db: Db, user: string, topic: string): Promise<number> {
  await actAs(db, asUser(user));
  await db.query("select set_config('realtime.topic', $1, true)", [topic]);
  return count(db, 'select 1 from realtime.messages where topic = $1', [topic]);
}

describe('realtime hints (BR-Q-08, BR-Q-09)', () => {
  it('broadcasts ids and versions only, on the board and doctor topics, at commit', async () => {
    await scenario(async (db, w) => {
      const e = await walkIn(db, w, w.patientA1);
      await actAs(db, asPostgres);
      // Other test files commit their own worlds: only this clinic's topics are looked at.
      const mine = `clinic:${w.clinicA}:%`;
      expect(await count(db, 'select 1 from realtime.messages where topic like $1', [mine])).toBe(0); // deferred until commit
      await db.query('set constraints public.doctor_sessions_broadcast_hint immediate');
      await db.query('set constraints public.doctor_sessions_broadcast_hint deferred');

      const day = await today(db);
      const session = (await one<{ s: string }>(db, 'select session_id as s from public.queue_entries where id = $1', [e.queue_entry_id])).s;
      const messages = (await db.query<{ topic: string; event: string; private: boolean; payload: Record<string, unknown> }>(
        'select topic, event, private, payload from realtime.messages where topic like $1 order by id', [mine])).rows;
      expect(messages.map((m) => m.topic)).toEqual([`clinic:${w.clinicA}:board:${day}`, `clinic:${w.clinicA}:doctor:${w.doctorA1}:${day}`]);
      for (const m of messages) {
        expect(m).toMatchObject({ event: 'queue_changed', private: true });
        expect(Object.keys(m.payload).sort()).toEqual(['doctor_id', 'queue_version', 'session_id']);
        expect(m.payload).toMatchObject({ session_id: session, doctor_id: w.doctorA1 });
      }
    });
  });

  it('authorizes topics per clinic and, for a practitioner-only doctor, per own agenda', async () => {
    await scenario(async (db, w) => {
      await walkIn(db, w, w.patientA1); // doctorA1
      await walkIn(db, w, w.patientA2, w.doctorA2);
      await actAs(db, asPostgres);
      await db.query('set constraints public.doctor_sessions_broadcast_hint immediate');
      await db.query('set constraints public.doctor_sessions_broadcast_hint deferred');
      const day = await today(db);
      const board = `clinic:${w.clinicA}:board:${day}`;
      const doctorA1 = `clinic:${w.clinicA}:doctor:${w.doctorA1}:${day}`;
      const doctorA2 = `clinic:${w.clinicA}:doctor:${w.doctorA2}:${day}`;

      expect(await receivable(db, w.users.receptionA, board)).toBeGreaterThan(0);
      expect(await receivable(db, w.users.receptionA, doctorA1)).toBeGreaterThan(0);
      expect(await receivable(db, w.users.doctorA, doctorA2)).toBeGreaterThan(0); // own agenda
      expect(await receivable(db, w.users.doctorA, doctorA1)).toBe(0); // another doctor's agenda
      for (const user of [w.users.ownerB, w.users.accountantA, w.users.patientAccount, w.users.outsider]) {
        expect(await receivable(db, user, board), user).toBe(0);
      }
      for (const malformed of [`clinic:${w.clinicA}`, `clinic:not-a-uuid:board:${day}`, `clinic:${w.clinicA}:board:today`, `queue:${w.clinicA}`]) {
        await actAs(db, asUser(w.users.receptionA));
        expect(await one(db, 'select private.can_receive_queue_topic($1) as ok', [malformed]), malformed).toEqual({ ok: false });
      }
    });
  });
});

describe('waiting-room display screens', () => {
  const CREATE = 'select * from public.create_display_screen($1, $2, $3::uuid[])';
  const SNAPSHOT = 'select public.display_snapshot($1) as s';

  it('creates a screen for owners and admins, returns its token once, and stores only a hash', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      expect((await failure(db, CREATE, [w.clinicA, 'Salle principale', null])).message).toBe('FORBIDDEN');
      await actAs(db, asUser(w.users.ownerB));
      expect((await failure(db, CREATE, [w.clinicA, 'Salle principale', null])).message).toBe('NOT_FOUND');
      await actAs(db, asUser(w.users.adminA));
      expect((await failure(db, CREATE, [w.clinicA, 'Salle', [w.doctorB1]])).message).toBe('VALIDATION_FAILED');
      const screen = await one<{ screen_id: string; display_token: string }>(db, CREATE, [w.clinicA, 'Salle principale', null]);
      expect(screen.display_token).toMatch(/^[0-9a-f]{64}$/);
      expect((await failure(db, 'select token_hash from public.queue_display_screens')).code).toBe('42501');
      await actAs(db, asPostgres);
      expect(await one(db, 'select token_hash = encode(extensions.digest($2, $3), $4) as hashed from public.queue_display_screens where id = $1',
        [screen.screen_id, screen.display_token, 'sha256', 'hex'])).toEqual({ hashed: true });
    });
  });

  it('shows ticket numbers and doctor names only, to anyone with the token, until revoked', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      await db.query("update public.user_profiles set full_name = 'Rania Accueil' where id = $1", [w.users.receptionA]);
      const first = await walkIn(db, w, w.patientA1);
      const second = await walkIn(db, w, w.patientA2);
      await actAs(db, asUser(w.users.ownerA));
      await db.query('select * from public.call_next((select session_id from public.queue_entries where id = $1))', [first.queue_entry_id]);
      await db.query('select public.start_consultation($1)', [first.queue_entry_id]);
      const all = await one<{ display_token: string }>(db, CREATE, [w.clinicA, 'Salle principale', null]);
      const onlyA2 = await one<{ display_token: string; screen_id: string }>(db, CREATE, [w.clinicA, 'Cabinet 2', [w.doctorA2]]);

      await actAs(db, asAnon);
      const snapshot = (await one<{ s: { clinic: string; doctors: Array<Record<string, unknown>> } }>(db, SNAPSHOT, [all.display_token])).s;
      const a1 = snapshot.doctors.find((d) => d['serving'] === first.ticket_number);
      expect(a1).toMatchObject({ serving: 1, called: [], next: [second.ticket_number], waiting: 1 });
      const text = JSON.stringify(snapshot);
      for (const forbidden of ['Alice', 'Bob', 'Alpha', 'P0000', '+999', 'Consultation', 'Rania']) expect(text, forbidden).not.toContain(forbidden);

      const filtered = (await one<{ s: { doctors: unknown[] } }>(db, SNAPSHOT, [onlyA2.display_token])).s;
      expect(filtered.doctors).toHaveLength(1);

      expect((await failure(db, SNAPSHOT, ['0'.repeat(64)])).message).toBe('NOT_FOUND');
      expect((await failure(db, SNAPSHOT, ['not a token'])).message).toBe('NOT_FOUND');
      await actAs(db, asUser(w.users.adminA));
      await db.query('select public.revoke_display_screen($1)', [onlyA2.screen_id]);
      await actAs(db, asAnon);
      expect((await failure(db, SNAPSHOT, [onlyA2.display_token])).message).toBe('NOT_FOUND');
      await actAs(db, asPostgres);
      expect(await count(db, 'select 1 from public.queue_display_screens where clinic_id = $1 and last_seen_at is not null', [w.clinicA])).toBe(2);
    });
  });
});

describe('patient portal queue status', () => {
  it("shows a linked patient their own ticket and how many patients are ahead, nobody else's", async () => {
    await scenario(async (db, w) => {
      await walkIn(db, w, w.patientA2); // ahead of patientA1
      const mine = await walkIn(db, w, w.patientA1);
      await actAs(db, asUser(w.users.patientAccount)); // linked to patientA1 only
      const rows = (await db.query<{ appointment_id: string; ticket_number: number; ahead: number; state: string }>(
        'select * from public.portal_get_my_queue_status()')).rows;
      expect(rows).toEqual([expect.objectContaining({ appointment_id: mine.appointment_id, ticket_number: 2, ahead: 1, state: 'waiting' })]);
      await actAs(db, asUser(w.users.outsider));
      expect((await db.query('select * from public.portal_get_my_queue_status()')).rowCount).toBe(0);
    });
  });
});

describe('end-of-day job', () => {
  it('closes only the sessions of past days', async () => {
    await scenario(async (db, w) => {
      await walkIn(db, w, w.patientA1); // today's session
      await actAs(db, asPostgres);
      await db.query(
        `insert into public.doctor_sessions (clinic_id, doctor_id, service_date, status)
         values ($1, $2, (now() at time zone 'Africa/Casablanca')::date - 1, 'open')`, [w.clinicA, w.doctorA2]);
      expect((await one<{ n: number }>(db, 'select private.close_stale_sessions() as n')).n).toBe(1);
      expect(await count(db, "select 1 from public.doctor_sessions where clinic_id = $1 and status = 'closed'", [w.clinicA])).toBe(1);
      expect(await count(db,
        "select 1 from public.doctor_sessions where clinic_id = $1 and service_date = (now() at time zone 'Africa/Casablanca')::date and status <> 'closed'",
        [w.clinicA])).toBe(1);
    });
  });
});
