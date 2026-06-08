import { describe, it, expect } from 'vitest';
import { MATERIALS, MATERIAL_IDS, getMaterial, type MaterialId } from '../acoustics/materials';
import { BAND_COUNT } from '../acoustics/types';

/** The nine materials the spec requires at minimum. */
const REQUIRED_IDS: readonly MaterialId[] = [
  'concrete',
  'plaster',
  'drywall',
  'carpet',
  'curtains',
  'acousticPanel',
  'woodFloor',
  'glass',
  'ceilingTile',
];

describe('MATERIALS database', () => {
  it('includes every required material', () => {
    for (const id of REQUIRED_IDS) {
      expect(MATERIALS[id]).toBeDefined();
    }
  });

  it('exposes all ids via MATERIAL_IDS', () => {
    expect(MATERIAL_IDS).toEqual(expect.arrayContaining([...REQUIRED_IDS]));
    expect(MATERIAL_IDS).toHaveLength(REQUIRED_IDS.length);
  });

  it('gives each material a name and 6 octave-band coefficients', () => {
    for (const id of MATERIAL_IDS) {
      const material = MATERIALS[id];
      expect(typeof material.name).toBe('string');
      expect(material.name.length).toBeGreaterThan(0);
      expect(material.absorption).toHaveLength(BAND_COUNT);
    }
  });

  it('keeps every coefficient within the physical [0, 1] range', () => {
    for (const id of MATERIAL_IDS) {
      for (const alpha of MATERIALS[id].absorption) {
        expect(alpha).toBeGreaterThanOrEqual(0);
        expect(alpha).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('getMaterial', () => {
  it('returns the record for a given id', () => {
    expect(getMaterial('carpet')).toBe(MATERIALS.carpet);
    expect(getMaterial('carpet').name).toBe('Carpet on concrete');
  });
});
