import { describe, expect, it } from 'vitest';

import {
  HISTORICAL_IMPORT_QUALITIES,
  HISTORICAL_IMPORT_SKIP_REASONS,
  HISTORICAL_IMPORT_VERSION,
  buildImportSummary,
  countConflict,
  countEvidenceTier,
  countQuality,
  countSkip,
  decideImportedFact,
  eligibilityForImportQuality,
  emptyImportSummaryCounters,
  importedFactMatches,
  parseHistoricalImportRun,
  provenanceIsAtLeast,
  provenanceStrength,
  sourceRef,
  worstImportQuality,
} from './model';
import type { HistoricalCaseFact } from '../historical-cases/model';

const ACCOUNT = 'account-1';

function fact(overrides: Partial<HistoricalCaseFact>): HistoricalCaseFact {
  return {
    id: 'fact-1',
    account_id: ACCOUNT,
    case_id: 'case-1',
    fact_key: 'postcode',
    value_source: 'canonical',
    value_text: null,
    value_number: null,
    value_integer: null,
    value_boolean: null,
    value_timestamp: null,
    provenance: 'imported_historical',
    source_message_id: null,
    source_media_id: null,
    observed_at: null,
    recorded_by_user_id: null,
    created_at: '2026-03-01T00:00:00.000Z',
    updated_at: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    account_id: ACCOUNT,
    source_type: 'enquiries',
    status: 'completed',
    started_at: '2026-03-01T09:00:00.000Z',
    completed_at: '2026-03-01T09:05:00.000Z',
    dry_run: true,
    records_examined: 0,
    cases_created: 0,
    cases_updated: 0,
    cases_reused: 0,
    facts_imported: 0,
    records_skipped: 0,
    ambiguous_records: 0,
    conflicts: 0,
    errors: 0,
    summary: {},
    error_metadata: [],
    importer_version: HISTORICAL_IMPORT_VERSION,
    triggered_by_user_id: 'user-1',
    created_at: '2026-03-01T09:00:00.000Z',
    ...overrides,
  };
}

describe('provenance strength', () => {
  it('puts a confirmed outcome above everything importable', () => {
    expect(provenanceStrength('confirmed_outcome')).toBeGreaterThan(
      provenanceStrength('imported_historical')
    );
    expect(provenanceStrength('confirmed_outcome')).toBeGreaterThan(
      provenanceStrength('operator_entered')
    );
  });

  it('treats an AI suggestion as the weakest thing in the vocabulary', () => {
    const strengths = [
      'confirmed_outcome',
      'operator_entered',
      'customer_stated',
      'image_observed',
      'system_derived',
      'imported_historical',
    ].map((provenance) =>
      provenanceStrength(provenance as 'confirmed_outcome')
    );
    for (const strength of strengths) {
      expect(strength).toBeGreaterThan(provenanceStrength('ai_suggested'));
    }
  });

  it('never lets an import satisfy the stronger side of a comparison', () => {
    expect(
      provenanceIsAtLeast('imported_historical', 'confirmed_outcome')
    ).toBe(false);
    expect(
      provenanceIsAtLeast('imported_historical', 'imported_historical')
    ).toBe(true);
    expect(
      provenanceIsAtLeast('operator_entered', 'customer_stated')
    ).toBe(true);
  });
});

describe('per-fact conflict resolution', () => {
  it('fills a gap', () => {
    const decision = decideImportedFact(null, {
      fact_key: 'postcode',
      value_source: 'canonical',
      provenance: 'imported_historical',
    });
    expect(decision).toEqual({ action: 'write' });
  });

  it('keeps a confirmed outcome and reports it', () => {
    const decision = decideImportedFact(
      fact({
        fact_key: 'final_amount_collected',
        value_source: 'captured',
        value_number: 385,
        provenance: 'confirmed_outcome',
      }),
      {
        fact_key: 'final_amount_collected',
        value_source: 'captured',
        provenance: 'imported_historical',
        value_number: 400,
      }
    );
    expect(decision).toEqual({
      action: 'conflict',
      reason: 'confirmed_value_retained',
    });
  });

  it('does not downgrade a stronger provenance to an imported one', () => {
    const decision = decideImportedFact(
      fact({
        fact_key: 'access_constraints',
        provenance: 'operator_entered',
      }),
      {
        fact_key: 'access_constraints',
        value_source: 'canonical',
        provenance: 'imported_historical',
      }
    );
    expect(decision).toEqual({
      action: 'conflict',
      reason: 'stronger_provenance_retained',
    });
  });

  it('treats an identical re-import as unchanged rather than a problem', () => {
    const decision = decideImportedFact(
      fact({ fact_key: 'address' }),
      {
        fact_key: 'address',
        value_source: 'canonical',
        provenance: 'imported_historical',
      }
    );
    expect(decision).toEqual({ action: 'skip', reason: 'value_unchanged' });
  });

  it('keeps the existing value when two readings disagree', () => {
    const decision = decideImportedFact(
      fact({
        fact_key: 'crew_count',
        value_source: 'captured',
        value_integer: 2,
        provenance: 'imported_historical',
      }),
      {
        fact_key: 'crew_count',
        value_source: 'captured',
        provenance: 'imported_historical',
        value_integer: 4,
      }
    );
    expect(decision).toEqual({
      action: 'conflict',
      reason: 'existing_value_retained',
    });
  });

  it('cannot manufacture a disagreement between two annotations', () => {
    // A canonical annotation carries no value, so a repeat of the same
    // key at the same provenance has nothing to disagree about. Calling
    // that a conflict would fill the conflict report with noise that
    // says nothing.
    const decision = decideImportedFact(
      fact({ fact_key: 'address', provenance: 'imported_historical' }),
      {
        fact_key: 'address',
        value_source: 'canonical',
        provenance: 'imported_historical',
      }
    );
    expect(decision).toEqual({ action: 'skip', reason: 'value_unchanged' });
  });

  it('compares a numeric fact in its own column', () => {
    const existing = fact({
      fact_key: 'crew_count',
      value_source: 'captured',
      value_integer: 2,
      provenance: 'operator_entered',
    });
    expect(
      importedFactMatches(existing, {
        fact_key: 'crew_count',
        value_source: 'captured',
        provenance: 'operator_entered',
        value_integer: 2,
      })
    ).toBe(true);
    expect(
      importedFactMatches(existing, {
        fact_key: 'crew_count',
        value_source: 'captured',
        provenance: 'operator_entered',
        value_integer: 3,
      })
    ).toBe(false);
  });

  it('treats unknown as unknown rather than as equal to a value', () => {
    const existing = fact({
      fact_key: 'actual_load_units',
      value_source: 'captured',
      value_number: null,
      provenance: 'imported_historical',
    });
    expect(
      importedFactMatches(existing, {
        fact_key: 'actual_load_units',
        value_source: 'captured',
        provenance: 'imported_historical',
        value_number: null,
      })
    ).toBe(true);
  });
});

describe('import quality is not evidence tier', () => {
  it('rolls a set of qualities up to the worst one', () => {
    expect(
      worstImportQuality(['exact', 'partial', 'exact'])
    ).toBe('partial');
    expect(
      worstImportQuality(['high_confidence_mapping', 'exact'])
    ).toBe('high_confidence_mapping');
    expect(worstImportQuality([])).toBeNull();
  });

  it('leaves an exact mapping eligible for training', () => {
    expect(eligibilityForImportQuality('exact')).toBeNull();
    expect(eligibilityForImportQuality('partial')).toBeNull();
  });

  it('withholds an ambiguous or unusable mapping from training', () => {
    expect(eligibilityForImportQuality('ambiguous')).toEqual({
      eligibility: 'excluded',
      reason: 'ambiguous',
      basis: 'import_policy',
    });
    expect(eligibilityForImportQuality('unusable')).toEqual({
      eligibility: 'excluded',
      reason: 'incomplete',
      basis: 'import_policy',
    });
  });
});

describe('bounded summaries', () => {
  it('counts skips, conflicts, quality and tiers', () => {
    const counters = emptyImportSummaryCounters();
    countSkip(counters, 'already_imported', 'enquiry:1');
    countSkip(counters, 'requires_enquiry_segmentation', 'legacy_conversation:2');
    countConflict(counters, 'confirmed_value_retained', 'enquiry:3');
    countQuality(counters, 'exact');
    countEvidenceTier(counters, null);
    counters.findings.add('no_structured_quote_source');

    const summary = buildImportSummary(counters, {
      cases_to_create: 2,
      cases_to_update: 0,
      cases_to_reuse: 1,
      facts_to_import: 9,
      media_references_to_record: 3,
    });

    expect(summary.skip_reasons).toEqual({
      already_imported: 1,
      requires_enquiry_segmentation: 1,
    });
    expect(summary.conflict_reasons).toEqual({
      confirmed_value_retained: 1,
    });
    expect(summary.import_quality).toEqual({ exact: 1 });
    expect(summary.evidence_tiers).toEqual({ unclassified: 1 });
    expect(summary.findings).toEqual(['no_structured_quote_source']);
    expect(summary.projection.cases_to_create).toBe(2);
  });

  it('caps the samples it keeps per reason', () => {
    const counters = emptyImportSummaryCounters();
    for (let index = 0; index < 40; index += 1) {
      countSkip(counters, 'already_imported', `enquiry:${index}`);
    }
    const summary = buildImportSummary(counters);
    expect(summary.samples.already_imported).toHaveLength(10);
    expect(summary.skip_reasons.already_imported).toBe(40);
  });

  it('refuses a summary that would not fit the database bound', () => {
    const counters = emptyImportSummaryCounters();
    // The real vocabularies cannot produce an oversized summary - six
    // skip reasons of ten 64-character samples is a few kilobytes. This
    // is the backstop for the day that stops being true, so it is
    // exercised by filling the counters past what the vocabularies
    // currently allow.
    const padded = (index: number) => `reason_${'x'.repeat(190)}_${index}`;
    for (let index = 0; index < 20; index += 1) {
      counters.skip_reasons.set(padded(index), 1);
      counters.conflict_reasons.set(padded(index), 1);
    }
    expect(() => buildImportSummary(counters)).toThrow(/exceeds/);
  });

  it('keeps every skip reason inside the closed vocabulary', () => {
    expect(HISTORICAL_IMPORT_SKIP_REASONS).toContain('already_imported');
    expect(HISTORICAL_IMPORT_SKIP_REASONS).toContain(
      'requires_enquiry_segmentation'
    );
    expect(HISTORICAL_IMPORT_QUALITIES).toEqual([
      'exact',
      'high_confidence_mapping',
      'partial',
      'ambiguous',
      'unusable',
    ]);
  });

  it('names a source record without naming the customer', () => {
    expect(sourceRef('enquiry', 'abc')).toBe('enquiry:abc');
    expect(sourceRef('enquiry', 'x'.repeat(200))).toHaveLength(64);
  });
});

describe('import run parsing', () => {
  it('refuses a dry run that claims to have created a case', () => {
    expect(() =>
      parseHistoricalImportRun(
        runRow({ dry_run: true, cases_created: 3 })
      )
    ).toThrow(/dry run cannot have created/);
  });

  it('refuses a finished run with no completion time', () => {
    expect(() =>
      parseHistoricalImportRun(
        runRow({ status: 'completed', completed_at: null })
      )
    ).toThrow(/finished exactly when/);
  });

  it('refuses a running run with a completion time', () => {
    expect(() =>
      parseHistoricalImportRun(
        runRow({ status: 'running', completed_at: '2026-03-01T09:05:00.000Z' })
      )
    ).toThrow(/finished exactly when/);
  });

  it('refuses an unknown source type', () => {
    expect(() =>
      parseHistoricalImportRun(runRow({ source_type: 'invoices' }))
    ).toThrow(/Invalid source_type/);
  });

  it('accepts an honest dry run', () => {
    const run = parseHistoricalImportRun(runRow());
    expect(run.dry_run).toBe(true);
    expect(run.cases_created).toBe(0);
    expect(run.summary.projection.cases_to_create).toBe(0);
  });

  it('never surfaces an unbounded error list', () => {
    const errorMetadata = Array.from({ length: 200 }, (_, index) => ({
      source_kind: 'enquiry',
      source_record_id: `enquiry-${index}`,
      reason: 'repository_database_error',
    }));
    const run = parseHistoricalImportRun(runRow({ error_metadata: errorMetadata }));
    expect(run.error_metadata.length).toBeLessThanOrEqual(50);
  });
});