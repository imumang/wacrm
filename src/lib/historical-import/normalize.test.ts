import { describe, expect, it } from 'vitest';

import {
  HISTORICAL_IMPORT_MAX_TEXT_LENGTH,
  hasTimezoneDesignator,
  normalizeInstant,
  normalizeText,
  normalizeTextList,
  normalizeUkPostcode,
} from './normalize';

describe('normalizeInstant', () => {
  it('canonicalizes an aware timestamp to UTC', () => {
    expect(normalizeInstant('2026-03-01T10:00:00+01:00')).toBe(
      '2026-03-01T09:00:00.000Z'
    );
    expect(normalizeInstant('2026-03-01T09:00:00Z')).toBe(
      '2026-03-01T09:00:00.000Z'
    );
  });

  it('refuses a timezone-less timestamp rather than assuming UTC', () => {
    expect(normalizeInstant('2026-03-01T09:00:00')).toBeNull();
    expect(normalizeInstant('09:00')).toBeNull();
    expect(normalizeInstant('yesterday')).toBeNull();
  });

  it('treats an absent value as unknown, not as an error', () => {
    expect(normalizeInstant(null)).toBeNull();
    expect(normalizeInstant(undefined)).toBeNull();
    expect(normalizeInstant('   ')).toBeNull();
    expect(normalizeInstant(1740000000)).toBeNull();
  });

  it('agrees with the timezone test the fact vocabulary uses', () => {
    expect(hasTimezoneDesignator('2026-03-01T09:00:00Z')).toBe(true);
    expect(hasTimezoneDesignator('2026-03-01T09:00:00+0100')).toBe(true);
    expect(hasTimezoneDesignator('2026-03-01T09:00:00')).toBe(false);
  });
});

describe('normalizeUkPostcode', () => {
  it('recognizes and canonicalizes a real postcode', () => {
    expect(normalizeUkPostcode('e14 9sh')).toBe('E14 9SH');
    expect(normalizeUkPostcode('SW1A1AA')).toBe('SW1A 1AA');
    expect(normalizeUkPostcode(' w1  1aa ')).toBe('W1 1AA');
  });

  it('refuses something that is not a postcode', () => {
    expect(normalizeUkPostcode('n/a')).toBeNull();
    expect(normalizeUkPostcode('???')).toBeNull();
    expect(normalizeUkPostcode('12345')).toBeNull();
    expect(normalizeUkPostcode('12 High Street, London')).toBeNull();
    expect(normalizeUkPostcode('')).toBeNull();
    expect(normalizeUkPostcode(null)).toBeNull();
  });
});

describe('normalizeText', () => {
  it('trims and collapses whitespace without rewriting anything else', () => {
    expect(normalizeText('  3   sofas\nand\t a fridge ')).toBe(
      '3 sofas and a fridge'
    );
    expect(normalizeText('Mr & Mrs Smith — 3rd floor')).toBe(
      'Mr & Mrs Smith — 3rd floor'
    );
  });

  it('does not re-case, re-spell or re-categorize', () => {
    expect(normalizeText('SOFA')).toBe('SOFA');
    expect(normalizeText('rubbish removal')).toBe('rubbish removal');
  });

  it('returns unknown for an empty or oversized value', () => {
    expect(normalizeText('   ')).toBeNull();
    expect(normalizeText(null)).toBeNull();
    expect(normalizeText(42)).toBeNull();
    expect(normalizeText('x'.repeat(HISTORICAL_IMPORT_MAX_TEXT_LENGTH + 1))).toBeNull();
  });
});

describe('normalizeTextList', () => {
  it('normalizes each entry and drops the empty ones', () => {
    expect(
      normalizeTextList(['  sofa  ', '', '   ', 'mattress\nbed'])
    ).toEqual(['sofa', 'mattress bed']);
  });

  it('de-duplicates entries that normalize to the same text', () => {
    expect(normalizeTextList(['sofa', ' sofa '])).toEqual(['sofa']);
  });

  it('returns unknown for an absent or empty list', () => {
    expect(normalizeTextList(null)).toBeNull();
    expect(normalizeTextList([])).toBeNull();
    expect(normalizeTextList(['', '  '])).toBeNull();
    expect(normalizeTextList('sofa')).toBeNull();
  });
});