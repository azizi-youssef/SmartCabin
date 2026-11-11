import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { actAs, asPostgres, asUser, count, createPool, failure, one, rowCount, withRollback, type Db } from './helpers/db';
import { acceptCurrentTerms, createWorld, localInstant, type World } from './helpers/fixtures';

/** Role behavior inside one clinic (RBAC_PERMISSION_MATRIX.md), enforced by RLS, grants and commands. */
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

describe('scoped visibility', () => {
  it('limits a practitioner-only doctor to their own appointments and patients', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.doctorA));
      const appts = (await db.query<{ id: string }>('select id from public.appointments where clinic_id = $1', [w.clinicA])).rows;
      expect(appts.map((r) => r.id)).toEqual([w.apptA1]);
      const patients = (await db.query<{ id: string }>('select id from public.patients where clinic_id = $1', [w.clinicA])).rows;
      expect(patients.map((r) => r.id)).toEqual([w.patientA1]);
      expect(await count(db, 'select 1 from public.appointment_history where appointment_id = $1', [w.apptA2])).toBe(0);
    });
  });

  it('gives an owner who is also a practitioner clinic-wide visibility', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.ownerA));
      expect(await count(db, 'select 1 from public.appointments where clinic_id = $1', [w.clinicA])).toBe(2);
    });
  });

  it('shows an accountant no patients and no appointments, but the catalog', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.accountantA));
      expect(await count(db, 'select 1 from public.patients')).toBe(0);
      expect(await count(db, 'select 1 from public.appointments')).toBe(0);
      expect(await count(db, 'select 1 from public.services where clinic_id = $1', [w.clinicA])).toBe(2);
    });
  });

  it('requires MFA for accountants too', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.accountantA, 'aal1'));
      expect(await count(db, 'select 1 from public.services where clinic_id = $1', [w.clinicA])).toBe(0);
    });
  });

  it('lets receptionists work with aal1 sessions (MFA optional for them)', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA, 'aal1'));
      expect(await count(db, 'select 1 from public.patients where clinic_id = $1', [w.clinicA])).toBe(2);
    });
  });
});

describe('managed-table writes by role', () => {
  it('lets a receptionist register a patient with a gapless, server-assigned file number', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      const first = await one<{ file_number: string; created_by: string; status: string }>(db,
        "insert into public.patients (clinic_id, first_name, last_name) values ($1, 'Nouveau', 'Patient') returning file_number, created_by, status",
        [w.clinicA]);
      const second = await one<{ file_number: string }>(db,
        "insert into public.patients (clinic_id, first_name, last_name) values ($1, 'Autre', 'Patient') returning file_number",
        [w.clinicA]);
      expect(first.file_number).toBe('P000003');
      expect(second.file_number).toBe('P000004');
      expect(first.created_by).toBe(w.users.receptionA);
      expect(first.status).toBe('active');
    });
  });

  it('refuses patient creation to doctors and accountants', async () => {
    await scenario(async (db, w) => {
      for (const who of ['doctorA', 'accountantA'] as const) {
        await actAs(db, asUser(w.users[who]));
        const err = await failure(db, "insert into public.patients (clinic_id, first_name, last_name) values ($1, 'X', 'Y')", [w.clinicA]);
        expect(err.code, who).toBe('42501');
      }
    });
  });

  it('refuses catalog changes to receptionists', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      const err = await failure(db,
        "insert into public.services (clinic_id, name_fr, default_duration_minutes, price_mad) values ($1, 'X', 20, 10)", [w.clinicA]);
      expect(err.code).toBe('42501');
      expect(await rowCount(db, 'update public.services set price_mad = 1 where clinic_id = $1', [w.clinicA])).toBe(0);
    });
  });

  it('lets a doctor manage only their own time off', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.doctorA));
      const ok = await rowCount(db,
        "insert into public.doctor_time_off (clinic_id, doctor_id, period) values ($1, $2, tstzrange(now() + interval '40 days', now() + interval '41 days'))",
        [w.clinicA, w.doctorA2]);
      expect(ok).toBe(1);
      const err = await failure(db,
        "insert into public.doctor_time_off (clinic_id, doctor_id, period) values ($1, $2, tstzrange(now() + interval '40 days', now() + interval '41 days'))",
        [w.clinicA, w.doctorA1]);
      expect(err.code).toBe('42501');
    });
  });

  it('blocks server-controlled columns through column grants', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      expect((await failure(db, "update public.patients set file_number = 'P999999' where id = $1", [w.patientA1])).code).toBe('42501');
      expect((await failure(db, "update public.patients set status = 'archived' where id = $1", [w.patientA1])).code).toBe('42501');
      await actAs(db, asUser(w.users.ownerA));
      expect((await failure(db, "update public.clinics set status = 'closed' where id = $1", [w.clinicA])).code).toBe('42501');
      expect((await failure(db, "update public.clinics set slug = 'stolen-slug' where id = $1", [w.clinicA])).code).toBe('42501');
      expect(await rowCount(db, "update public.clinics set display_name = 'Clinique A renommée' where id = $1", [w.clinicA])).toBe(1);
    });
  });

  it('blocks writes in a suspended clinic but keeps reads', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      await db.query("update public.clinics set status = 'suspended', suspended_reason = 'test' where id = $1", [w.clinicA]);
      await actAs(db, asUser(w.users.receptionA));
      expect(await count(db, 'select 1 from public.patients where clinic_id = $1', [w.clinicA])).toBe(2);
      const err = await failure(db, "insert into public.patients (clinic_id, first_name, last_name) values ($1, 'X', 'Y')", [w.clinicA]);
      expect(err.code).toBe('42501');
      const booking = await failure(db, 'select public.book_appointment($1, $2, $3, $4)',
        [w.patientA1, w.doctorA1, w.serviceA, await localInstant(db, w.day, '11:00')]);
      expect(booking.message).toBe('FORBIDDEN');
    });
  });
});

describe('memberships and invitations', () => {
  it('runs the invitation flow end to end, single use, with email matching', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      const invitee = await one<{ id: string; email: string }>(db,
        "insert into auth.users (id, aud, role, email, email_confirmed_at) values (gen_random_uuid(), 'authenticated', 'authenticated', 'new.staff.' || gen_random_uuid() || '@example.test', now()) returning id, email");

      await actAs(db, asUser(w.users.ownerA));
      const inv = await one<{ invitation_id: string; invitation_token: string }>(db,
        "select * from public.invite_member($1, $2, 'receptionist')", [w.clinicA, invitee.email.toUpperCase()]);
      expect(inv.invitation_token).toMatch(/^[0-9a-f]{64}$/);

      await actAs(db, asUser(w.users.outsider));
      expect((await failure(db, 'select public.accept_invitation($1)', [inv.invitation_token])).message).toBe('INVITATION_EMAIL_MISMATCH');

      await actAs(db, asUser(invitee.id, 'aal1'));
      const clinic = await one<{ accept_invitation: string }>(db, 'select public.accept_invitation($1)', [inv.invitation_token]);
      expect(clinic.accept_invitation).toBe(w.clinicA);
      expect((await failure(db, 'select public.accept_invitation($1)', [inv.invitation_token])).message).toBe('INVITATION_INVALID');

      await actAs(db, asPostgres);
      const member = await one<{ role: string; status: string }>(db,
        'select role, status from public.clinic_members where clinic_id = $1 and user_id = $2', [w.clinicA, invitee.id]);
      expect(member).toEqual({ role: 'receptionist', status: 'active' });
    });
  });

  it('rejects expired invitations and unknown tokens with the same error', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.ownerA));
      const inv = await one<{ invitation_id: string; invitation_token: string }>(db,
        "select * from public.invite_member($1, 'late@example.test', 'accountant')", [w.clinicA]);
      await actAs(db, asPostgres);
      await db.query("update public.clinic_invitations set created_at = now() - interval '8 days', expires_at = now() - interval '1 day' where id = $1", [inv.invitation_id]);
      await actAs(db, asUser(w.users.outsider));
      expect((await failure(db, 'select public.accept_invitation($1)', [inv.invitation_token])).message).toBe('INVITATION_INVALID');
      expect((await failure(db, "select public.accept_invitation('deadbeef')")).message).toBe('INVITATION_INVALID');
    });
  });

  it('keeps admins away from owner/admin roles and members away from their own role', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.adminA));
      expect((await failure(db, "select * from public.invite_member($1, 'boss@example.test', 'clinic_admin')", [w.clinicA])).message).toBe('FORBIDDEN');
      const ownerMember = await one<{ id: string }>(db, 'select id from public.clinic_members where clinic_id = $1 and user_id = $2', [w.clinicA, w.users.ownerA]);
      expect((await failure(db, "select public.set_member_status($1, 'suspended')", [ownerMember.id])).message).toBe('FORBIDDEN');
      const adminMember = await one<{ id: string }>(db, 'select id from public.clinic_members where clinic_id = $1 and user_id = $2', [w.clinicA, w.users.adminA]);
      expect((await failure(db, "select public.change_member_role($1, 'clinic_owner')", [adminMember.id])).message).toBe('FORBIDDEN');
      const receptionMember = await one<{ id: string }>(db, 'select id from public.clinic_members where clinic_id = $1 and user_id = $2', [w.clinicA, w.users.receptionA]);
      await db.query("select public.change_member_role($1, 'accountant')", [receptionMember.id]);
      await actAs(db, asPostgres);
      expect((await one<{ role: string }>(db, 'select role from public.clinic_members where id = $1', [receptionMember.id])).role).toBe('accountant');
    });
  });

  it('keeps at least one active owner (deferred check at commit)', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      await db.query("update public.clinic_members set role = 'clinic_admin' where clinic_id = $1 and user_id = $2", [w.clinicA, w.users.ownerA]);
      const err = await failure(db, 'set constraints all immediate');
      expect(err.message).toBe('LAST_OWNER');
    });
  });

  it('removes all access immediately when a member is suspended', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.ownerA));
      const member = await one<{ id: string }>(db, 'select id from public.clinic_members where clinic_id = $1 and user_id = $2', [w.clinicA, w.users.receptionA]);
      await db.query("select public.set_member_status($1, 'suspended')", [member.id]);
      await actAs(db, asUser(w.users.receptionA));
      expect(await count(db, 'select 1 from public.patients where clinic_id = $1', [w.clinicA])).toBe(0);
    });
  });

  it('never exposes invitation token hashes', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.ownerA));
      await db.query("select * from public.invite_member($1, 'hash@example.test', 'receptionist')", [w.clinicA]);
      expect((await failure(db, 'select token_hash from public.clinic_invitations')).code).toBe('42501');
      expect(await count(db, 'select id, email from public.clinic_invitations where clinic_id = $1', [w.clinicA])).toBe(1);
    });
  });
});

describe('clinic onboarding and platform path', () => {
  it('creates a pending clinic with settings and an owner membership', async () => {
    await scenario(async (db, w) => {
      await acceptCurrentTerms(db, w.users.outsider);
      await actAs(db, asUser(w.users.outsider, 'aal1'));
      const slug = `new-clinic-${Date.now()}`;
      const created = await one<{ create_clinic: string }>(db, "select public.create_clinic('Nouvelle Clinique', $1, 'Nador')", [slug]);
      const memberships = (await db.query('select * from public.get_my_memberships()')).rows;
      expect(memberships).toEqual([expect.objectContaining({
        clinic_id: created.create_clinic, slug, clinic_status: 'pending_approval', role: 'clinic_owner', requires_mfa: true,
      })]);
      expect((await failure(db, "select public.create_clinic('Copie', $1, 'Nador')", [slug])).message).toBe('SLUG_TAKEN');
      await actAs(db, asPostgres);
      expect(await count(db, 'select 1 from public.clinic_settings where clinic_id = $1', [created.create_clinic])).toBe(1);
      expect(await count(db, "select 1 from public.domain_events where aggregate_id = $1 and event_type = 'clinic.submitted'", [created.create_clinic])).toBe(1);
    });
  });

  it('refuses clinic creation to accounts with an unconfirmed email', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.unconfirmed));
      expect((await failure(db, "select public.create_clinic('X Clinic', 'x-clinic-unconfirmed', 'Nador')")).message).toBe('EMAIL_NOT_CONFIRMED');
    });
  });

  it('reserves clinic status changes to platform admins with MFA', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.ownerA));
      expect((await failure(db, "select public.platform_set_clinic_status($1, 'closed')", [w.clinicA])).message).toBe('FORBIDDEN');
      await actAs(db, asUser(w.users.platformAdmin, 'aal1'));
      expect((await failure(db, "select public.platform_set_clinic_status($1, 'suspended', 'r')", [w.clinicA])).message).toBe('FORBIDDEN');
      await actAs(db, asUser(w.users.platformAdmin, 'aal2'));
      await db.query("select public.platform_set_clinic_status($1, 'suspended', 'Unpaid subscription')", [w.clinicA]);
      expect((await failure(db, "select public.platform_set_clinic_status($1, 'pending_approval')", [w.clinicA])).message).toBe('CLINIC_INVALID_TRANSITION');
      await actAs(db, asPostgres);
      const audit = await one<{ actor_type: string; changed_fields: string[] }>(db,
        "select actor_type, changed_fields from public.audit_logs where entity_type = 'clinics' and entity_id = $1 and action = 'clinics.update' order by id desc limit 1",
        [w.clinicA]);
      expect(audit.actor_type).toBe('platform_admin');
      expect(audit.changed_fields).toEqual(expect.arrayContaining(['status', 'suspended_reason']));
    });
  });
});
