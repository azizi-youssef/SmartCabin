import { describe, expect, it } from 'vitest';

import { groupBySpecialty, relativeDay, specialtyFilter, type DirectoryDoctor } from './domain';

function doctor(id: string, over: Partial<DirectoryDoctor> = {}): DirectoryDoctor {
  return {
    id,
    name: `Dr ${id}`,
    nameAr: null,
    specialtyCode: null,
    specialtyFr: null,
    specialtyAr: null,
    clinicSlug: 'cabinet',
    clinicName: 'Cabinet',
    clinicCity: 'Nador',
    clinicAddress: null,
    clinicTimezone: 'Africa/Casablanca',
    minPriceMad: '200.00',
    nextSlotAt: null,
    ...over,
  };
}

const cardio = { specialtyCode: 'cardiology', specialtyFr: 'Cardiologie', specialtyAr: 'أمراض القلب' };
const peds = { specialtyCode: 'pediatrics', specialtyFr: 'Pédiatrie', specialtyAr: 'طب الأطفال' };
const derm = { specialtyCode: 'dermatology', specialtyFr: 'Dermatologie', specialtyAr: 'الأمراض الجلدية' };

describe('doctor directory grouping', () => {
  const list = [
    doctor('Zed', { ...peds, nextSlotAt: '2026-11-14T09:00:00Z' }),
    doctor('Other'),
    doctor('Late', { ...cardio, nextSlotAt: '2026-11-20T09:00:00Z' }),
    doctor('Full', { ...cardio }),
    doctor('Soon', { ...cardio, nextSlotAt: '2026-11-13T09:00:00Z' }),
    doctor('Skin', { ...derm, nextSlotAt: '2026-11-13T10:00:00Z' }),
  ];

  it('orders specialties alphabetically for the reader, with "no specialty" last', () => {
    expect(groupBySpecialty(list, 'fr', 'Autres').map((g) => g.label)).toEqual(['Cardiologie', 'Dermatologie', 'Pédiatrie', 'Autres']);
    const ar = groupBySpecialty(list, 'ar', 'أخرى').map((g) => g.code);
    expect(ar.at(-1)).toBeNull();
    expect(ar.slice(0, 3).sort()).toEqual(['cardiology', 'dermatology', 'pediatrics']);
  });

  it('puts the soonest available doctor first, those without a free slot last', () => {
    const cardiology = groupBySpecialty(list, 'fr', 'Autres')[0]!;
    expect(cardiology.doctors.map((d) => d.id)).toEqual(['Soon', 'Late', 'Full']);
  });

  it('keeps only a specialty filter that matches a listed group', () => {
    const groups = groupBySpecialty(list, 'fr', 'Autres');
    expect(specialtyFilter('cardiology', groups)).toBe('cardiology');
    expect(specialtyFilter(['pediatrics', 'x'], groups)).toBe('pediatrics');
    expect(specialtyFilter('autres', groups)).toBe('autres');
    expect(specialtyFilter('radiology', groups)).toBeNull();
    expect(specialtyFilter('<script>', groups)).toBeNull();
    expect(specialtyFilter(undefined, groups)).toBeNull();
    expect(specialtyFilter('autres', groupBySpecialty([doctor('A', cardio)], 'fr', 'Autres'))).toBeNull();
  });

  it('names today and tomorrow in the clinic calendar', () => {
    expect(relativeDay('2026-11-12', '2026-11-12', '2026-11-13')).toBe('today');
    expect(relativeDay('2026-11-13', '2026-11-12', '2026-11-13')).toBe('tomorrow');
    expect(relativeDay('2026-11-14', '2026-11-12', '2026-11-13')).toBeNull();
  });
});
