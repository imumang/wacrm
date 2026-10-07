import { describe, expect, it } from 'vitest';

import {
  assertValidEnquiryTransition,
  EnquiryValidationError,
  INITIAL_ENQUIRY_STATE,
  InvalidEnquiryTransitionError,
  isValidEnquiryTransition,
  parseEnquiryFactsPatch,
} from './model';

describe('enquiry workflow state', () => {
  it('starts every explicitly-created enquiry at new_enquiry', () => {
    expect(INITIAL_ENQUIRY_STATE).toBe('new_enquiry');
  });

  it.each([
    ['new_enquiry', 'gathering_information'],
    ['new_enquiry', 'ready_for_quote'],
    ['gathering_information', 'awaiting_photos'],
    ['awaiting_photos', 'ready_for_quote'],
    ['ready_for_quote', 'quote_draft'],
    ['quote_draft', 'quote_sent'],
    ['quote_sent', 'awaiting_acceptance'],
    ['awaiting_acceptance', 'booking_requested'],
    ['booking_requested', 'booked'],
    ['booked', 'reschedule_requested'],
    ['reschedule_requested', 'booked'],
    ['booked', 'completed'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(isValidEnquiryTransition(from, to)).toBe(true);
    expect(() => assertValidEnquiryTransition(from, to)).not.toThrow();
  });

  it('treats a repeated state as an idempotent no-op', () => {
    expect(isValidEnquiryTransition('quote_draft', 'quote_draft')).toBe(true);
  });

  it.each([
    ['new_enquiry', 'booked'],
    ['ready_for_quote', 'new_enquiry'],
    ['booking_requested', 'quote_draft'],
    ['reschedule_requested', 'completed'],
  ] as const)('rejects invalid transition %s -> %s', (from, to) => {
    expect(isValidEnquiryTransition(from, to)).toBe(false);
    expect(() => assertValidEnquiryTransition(from, to)).toThrow(
      InvalidEnquiryTransitionError
    );
  });

  it.each(['cancelled', 'completed'] as const)(
    'protects terminal state %s from reactivation',
    (state) => {
      expect(isValidEnquiryTransition(state, 'gathering_information')).toBe(
        false
      );
      expect(isValidEnquiryTransition(state, 'booked')).toBe(false);
    }
  );
});

describe('enquiry fact validation', () => {
  it('accepts partial information and preserves explicit unknowns', () => {
    expect(
      parseEnquiryFactsPatch({
        postcode: ' SW1A 1AA ',
        lift_available: null,
        item_descriptions: ['Sofa', 'Table'],
        photos_received: false,
      })
    ).toEqual({
      postcode: 'SW1A 1AA',
      lift_available: null,
      item_descriptions: ['Sofa', 'Table'],
      photos_received: false,
    });
  });

  it('keeps missing information explicit, typed, and duplicate-free', () => {
    expect(
      parseEnquiryFactsPatch({
        missing_information: ['postcode', 'item_descriptions', 'postcode'],
      })
    ).toEqual({
      missing_information: ['postcode', 'item_descriptions'],
    });
  });

  it('rejects unsupported missing-information keys', () => {
    expect(() =>
      parseEnquiryFactsPatch({ missing_information: ['invented_field'] })
    ).toThrow(EnquiryValidationError);
  });

  it('rejects blank facts, invalid dates, and unknown properties', () => {
    expect(() => parseEnquiryFactsPatch({ postcode: '   ' })).toThrow(
      /postcode/
    );
    expect(() =>
      parseEnquiryFactsPatch({ preferred_date: '2026-02-30' })
    ).toThrow(/valid date/);
    expect(() => parseEnquiryFactsPatch({ quote_price: 100 })).toThrow(
      /Unknown enquiry fact/
    );
  });
});
