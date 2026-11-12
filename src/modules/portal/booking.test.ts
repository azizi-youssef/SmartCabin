import { describe, expect, it } from 'vitest';

import { addDays, doctorsFor, newPersonErrors, servicesOf, slotsByDay, type NewPersonInput, type Offering } from './booking-domain';

const offering = (doctorId: string, serviceId: string): Offering => ({
  doctorId, doctorName: `Dr ${doctorId}`, doctorNameAr: null, serviceId, serviceNameFr: `S ${serviceId}`, serviceNameAr: null,
  durationMinutes: 20, priceMad: '200.00',
});

describe('online booking choices (S7)', () => {
  it('lists each service once and the doctors offering it', () => {
    const offers = [offering('a', 's1'), offering('b', 's1'), offering('a', 's2')];
    expect(servicesOf(offers).map((o) => o.serviceId)).toEqual(['s1', 's2']);
    expect(doctorsFor(offers, 's1').map((o) => o.doctorId)).toEqual(['a', 'b']);
    expect(doctorsFor(offers, 's3')).toEqual([]);
  });

  it('groups slots by their local date in the clinic time zone, across midnight UTC', () => {
    // 23:30 UTC on 2026-11-15 is 00:30 on 2026-11-16 in Casablanca (UTC+1).
    const groups = slotsByDay(['2026-11-16T08:00:00.000Z', '2026-11-15T23:30:00.000Z', '2026-11-15T09:00:00.000Z'], 'Africa/Casablanca');
    expect(groups).toEqual([
      { day: '2026-11-15', slots: ['2026-11-15T09:00:00.000Z'] },
      { day: '2026-11-16', slots: ['2026-11-15T23:30:00.000Z', '2026-11-16T08:00:00.000Z'] },
    ]);
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
  });

  it('requires a name, a valid optional birth date and the data-processing consent', () => {
    const base: NewPersonInput = { firstName: 'Nadia', lastName: 'Test', relationship: 'self', dateOfBirth: '', dataProcessing: true, remindersSms: false };
    expect(newPersonErrors(base, '2026-11-12')).toEqual({});
    expect(newPersonErrors({ ...base, firstName: ' ', dataProcessing: false }, '2026-11-12')).toEqual({ firstName: 'required', dataProcessing: 'required' });
    expect(newPersonErrors({ ...base, dateOfBirth: '2030-01-01' }, '2026-11-12')).toEqual({ dateOfBirth: 'invalid' });
    expect(newPersonErrors({ ...base, lastName: 'x'.repeat(81) }, '2026-11-12')).toEqual({ lastName: 'invalid' });
  });
});
