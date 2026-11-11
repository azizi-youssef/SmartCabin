import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { actAs, asPostgres, asUser, createPool, one } from './helpers/db';
import { createWorld, localInstant, type World } from './helpers/fixtures';

/**
 * Real concurrency: N independent connections run the same command at the same time and
 * COMMIT. Only database guarantees (exclusion constraint, unique index, row locks) can make
 * these pass — application code is not involved.
 *
 * The fixture is committed (it must be visible to every connection). Rows are left in the
 * LOCAL test database with random ids and `test-*` slugs; `supabase db reset` clears them.
 */
const PARALLEL = 10;
let pool: pg.Pool;
let w: World;

beforeAll(async () => {
  pool = createPool(PARALLEL + 2);
  const db = await pool.connect();
  try {
    await db.query('begin');
    w = await createWorld(db);
    await db.query('commit');
  } finally {
    db.release();
  }
});

afterAll(async () => {
  await pool.end();
});

type Outcome = { ok: true; id: string } | { ok: false; message: string; code: string | undefined };

/** Runs one booking in its own connection and transaction, as the clinic A receptionist. */
async function bookConcurrently(patient: string, startsAt: string, key: string | null, barrier: Promise<void>): Promise<Outcome> {
  const db = await pool.connect();
  try {
    await db.query('begin');
    await actAs(db, asUser(w.users.receptionA));
    await barrier;
    const row = await one<{ id: string }>(db, 'select id from public.book_appointment($1, $2, $3, $4, $5)',
      [patient, w.doctorA1, w.serviceA, startsAt, key]);
    await db.query('commit');
    return { ok: true, id: row.id };
  } catch (error) {
    await db.query('rollback');
    const e = error as { message: string; code?: string };
    return { ok: false, message: e.message, code: e.code };
  } finally {
    db.release();
  }
}

function gate(): { open: () => void; barrier: Promise<void> } {
  let open = (): void => undefined;
  const barrier = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, barrier };
}

async function instant(time: string): Promise<string> {
  return instantOn(0, time);
}

async function instantOn(plusDays: number, time: string): Promise<string> {
  const db = await pool.connect();
  try {
    return await localInstant(db, w.day, time, plusDays);
  } finally {
    db.release();
  }
}

/** 'HH:MM' from minutes after midnight. */
function minutes(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Runs one reschedule in its own connection and transaction, as the clinic A receptionist. */
async function rescheduleConcurrently(appointmentId: string, startsAt: string, barrier: Promise<void>): Promise<Outcome> {
  const db = await pool.connect();
  try {
    await db.query('begin');
    await actAs(db, asUser(w.users.receptionA));
    await barrier;
    const row = await one<{ id: string }>(db, 'select id from public.reschedule_appointment($1, $2)', [appointmentId, startsAt]);
    await db.query('commit');
    return { ok: true, id: row.id };
  } catch (error) {
    await db.query('rollback');
    const e = error as { message: string; code?: string };
    return { ok: false, message: e.message, code: e.code };
  } finally {
    db.release();
  }
}

/** Committed pairs of overlapping active, non-overbooked appointments for a doctor (must be 0). */
async function committedOverlaps(doctorId: string): Promise<number> {
  const db = await pool.connect();
  try {
    await actAs(db, asPostgres);
    const row = await one<{ n: number }>(db,
      `select count(*)::int as n
       from public.appointments a join public.appointments b
         on a.doctor_id = b.doctor_id and a.id < b.id
        and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)')
       where a.doctor_id = $1
         and a.status in ('pending', 'confirmed', 'checked_in', 'in_progress') and not a.is_overbooked
         and b.status in ('pending', 'confirmed', 'checked_in', 'in_progress') and not b.is_overbooked`,
      [doctorId]);
    return row.n;
  } finally {
    db.release();
  }
}

describe('concurrent booking', () => {
  it(`lets exactly one of ${PARALLEL} simultaneous bookings of the same slot succeed`, async () => {
    const startsAt = await instant('11:00');
    const g = gate();
    const pending = Array.from({ length: PARALLEL }, (_, i) =>
      bookConcurrently(i % 2 === 0 ? w.patientA1 : w.patientA2, startsAt, null, g.barrier));
    g.open();
    const outcomes = await Promise.all(pending);

    const successes = outcomes.filter((o) => o.ok);
    const failures = outcomes.filter((o): o is Extract<Outcome, { ok: false }> => !o.ok);
    expect(successes).toHaveLength(1);
    expect(failures.map((f) => f.message)).toEqual(Array(PARALLEL - 1).fill('SLOT_UNAVAILABLE'));

    const db = await pool.connect();
    try {
      await actAs(db, asPostgres);
      const rows = await one<{ n: number }>(db,
        "select count(*)::int as n from public.appointments where doctor_id = $1 and starts_at = $2 and status = 'confirmed'",
        [w.doctorA1, startsAt]);
      expect(rows.n).toBe(1);
    } finally {
      db.release();
    }
  });

  it('never commits two overlapping appointments when start times differ', async () => {
    const starts = await Promise.all(['13:00', '13:05', '13:10', '13:15', '13:20', '13:25', '13:30', '13:35'].map(instant));
    const g = gate();
    const pending = starts.map((s, i) => bookConcurrently(w.patientA1, s, `overlap-${i}-${w.clinicA}`, g.barrier));
    g.open();
    const outcomes = await Promise.all(pending);
    expect(outcomes.filter((o) => o.ok).length).toBeGreaterThanOrEqual(1);
    expect(outcomes.filter((o) => !o.ok).every((o) => !o.ok && o.message === 'SLOT_UNAVAILABLE')).toBe(true);

    const db = await pool.connect();
    try {
      const overlaps = await one<{ n: number }>(db,
        `select count(*)::int as n
         from public.appointments a join public.appointments b
           on a.doctor_id = b.doctor_id and a.id < b.id
          and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)')
         where a.doctor_id = $1
           and a.status in ('pending', 'confirmed', 'checked_in', 'in_progress') and not a.is_overbooked
           and b.status in ('pending', 'confirmed', 'checked_in', 'in_progress') and not b.is_overbooked`,
        [w.doctorA1]);
      expect(overlaps.n).toBe(0);
    } finally {
      db.release();
    }
  });

  it('turns concurrent retries with one idempotency key into a single appointment', async () => {
    const startsAt = await instant('15:00');
    const key = `retry-${w.clinicA}`;
    const g = gate();
    const pending = Array.from({ length: 6 }, () => bookConcurrently(w.patientA2, startsAt, key, g.barrier));
    g.open();
    const outcomes = await Promise.all(pending);

    expect(outcomes.filter((o) => !o.ok)).toEqual([]);
    const ids = new Set(outcomes.map((o) => (o.ok ? o.id : '')));
    expect(ids.size).toBe(1);
  });

  /**
   * SC-AUD-23: simultaneous overlapping requests for one doctor used to deadlock (40P01) on the
   * exclusion constraint instead of answering SLOT_UNAVAILABLE. Many rounds, because a single
   * round only reproduces the deadlock now and then. Rounds use days after the fixture's day.
   */
  it('answers SLOT_UNAVAILABLE, never a deadlock, to simultaneous overlapping bookings (24 rounds)', async () => {
    const unexpected: string[] = [];
    for (let round = 0; round < 24; round++) {
      const plusDays = 7 * (1 + Math.floor(round / 12)); // two Mondays after the fixture day
      const base = 8 * 60 + (round % 12) * 50; // 12 windows of 50 minutes, 08:00-18:00
      const starts = await Promise.all([0, 5, 10, 15, 20, 25].map((m) => instantOn(plusDays, minutes(base + m))));
      const g = gate();
      const pending = starts.map((s, i) => bookConcurrently(w.patientA1, s, `stress-${round}-${i}-${w.clinicA}`, g.barrier));
      g.open();
      const outcomes = await Promise.all(pending);
      if (!outcomes.some((o) => o.ok)) unexpected.push(`round ${round}: no booking succeeded`);
      for (const o of outcomes) if (!o.ok && o.message !== 'SLOT_UNAVAILABLE') unexpected.push(`round ${round}: ${o.code} ${o.message}`);
    }
    expect(unexpected).toEqual([]);
    expect(await committedOverlaps(w.doctorA1)).toBe(0);
  });

  it('answers SLOT_UNAVAILABLE, never a deadlock, to simultaneous overlapping reschedules (9 rounds)', async () => {
    const unexpected: string[] = [];
    for (let round = 0; round < 9; round++) {
      const plusDays = 7 * (3 + Math.floor(round / 3)); // days +21, +28, +35
      const base = 8 * 60 + (round % 3) * 200; // sources then targets, inside 08:00-18:00
      const sources: string[] = [];
      for (let i = 0; i < 6; i++) {
        const booked = await bookConcurrently(w.patientA2, await instantOn(plusDays, minutes(base + i * 20)), null, Promise.resolve());
        if (!booked.ok) throw new Error(`setup booking failed: ${booked.message}`);
        sources.push(booked.id);
      }
      const targets = await Promise.all([0, 5, 10, 15, 20, 25].map((m) => instantOn(plusDays, minutes(base + 130 + m))));
      const g = gate();
      const pending = sources.map((id, i) => rescheduleConcurrently(id, targets[i] ?? '', g.barrier));
      g.open();
      const outcomes = await Promise.all(pending);
      if (!outcomes.some((o) => o.ok)) unexpected.push(`round ${round}: no reschedule succeeded`);
      for (const o of outcomes) if (!o.ok && o.message !== 'SLOT_UNAVAILABLE') unexpected.push(`round ${round}: ${o.code} ${o.message}`);
    }
    expect(unexpected).toEqual([]);
    expect(await committedOverlaps(w.doctorA1)).toBe(0);
  });

  it('hands out gapless patient file numbers under concurrent registration', async () => {
    const g = gate();
    const pending = Array.from({ length: PARALLEL }, async (_, i) => {
      const db = await pool.connect();
      try {
        await db.query('begin');
        await actAs(db, asUser(w.users.receptionA));
        await g.barrier;
        const row = await one<{ file_number: string }>(db,
          "insert into public.patients (clinic_id, first_name, last_name) values ($1, 'Concurrent', $2) returning file_number",
          [w.clinicA, `Patient ${i}`]);
        await db.query('commit');
        return row.file_number;
      } finally {
        db.release();
      }
    });
    g.open();
    const numbers = (await Promise.all(pending)).sort();
    // The fixture created P000001 and P000002 in this clinic.
    expect(numbers).toEqual(Array.from({ length: PARALLEL }, (_, i) => `P${String(i + 3).padStart(6, '0')}`));
  });
});
