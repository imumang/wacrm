/**
 * Canonical quote-domain vocabulary and runtime validation.
 *
 * Money is stored as integer minor units. `30000` in `GBP` means £300.00.
 * No function in this module accepts a floating-point major-unit amount.
 */

export const QUOTE_ORIGINS = [
  'manual',
  'ai_suggested',
  'hybrid_engine',
  'imported_historical',
] as const;

export const QUOTE_WORKFLOW_STATUSES = [
  'draft',
  'awaiting_approval',
  'approved',
  'presented',
  'expired',
  'superseded',
  'withdrawn',
] as const;

export const QUOTE_CUSTOMER_DECISIONS = [
  'unknown',
  'accepted',
  'rejected_price',
  'found_better_price',
  'no_response',
  'cancelled_by_customer',
  'other_lost',
] as const;

export const QUOTE_AMOUNT_TYPES = ['fixed', 'range'] as const;

/**
 * Structured feedback only. These are operator labels, not assertions about
 * why a price was objectively right or wrong. `other` keeps the vocabulary
 * forward-compatible while business policy remains unresolved.
 */
export const QUOTE_OVERRIDE_REASONS = [
  'image_underestimated_volume',
  'image_overestimated_volume',
  'access_difficulty',
  'additional_items',
  'unusual_disposal_cost',
  'travel_distance',
  'market_commercial_adjustment',
  'customer_specific_adjustment',
  'manual_judgement',
  'other',
] as const;

export const QUOTE_EVENT_TYPES = [
  'created',
  'awaiting_approval',
  'approved',
  'presented',
  'customer_decision_recorded',
  'expired',
  'withdrawn',
  'superseded',
] as const;

export type QuoteOrigin = (typeof QUOTE_ORIGINS)[number];
export type QuoteWorkflowStatus = (typeof QUOTE_WORKFLOW_STATUSES)[number];
export type QuoteCustomerDecision = (typeof QUOTE_CUSTOMER_DECISIONS)[number];
export type QuoteAmountType = (typeof QUOTE_AMOUNT_TYPES)[number];
export type QuoteOverrideReason = (typeof QUOTE_OVERRIDE_REASONS)[number];
export type QuoteEventType = (typeof QUOTE_EVENT_TYPES)[number];

export interface QuoteProposal {
  currency: string;
  amount_type: QuoteAmountType;
  fixed_amount_minor: number | null;
  range_min_minor: number | null;
  range_max_minor: number | null;
  assumptions: string[];
  exclusions: string[];
  operator_notes: string | null;
  source_reference: string | null;
  source_observed_at: string | null;
  override_reason: QuoteOverrideReason | null;
  override_reason_note: string | null;
}

export interface Quote extends QuoteProposal {
  id: string;
  account_id: string;
  enquiry_id: string;
  revision_number: number;
  status: QuoteWorkflowStatus;
  customer_decision: QuoteCustomerDecision;
  origin: QuoteOrigin;
  supersedes_quote_id: string | null;
  superseded_by_quote_id: string | null;
  recommendation_quote_id: string | null;
  created_by_user_id: string;
  approved_at: string | null;
  approved_by_user_id: string | null;
  presented_at: string | null;
  presented_by_user_id: string | null;
  decision_recorded_at: string | null;
  decision_recorded_by_user_id: string | null;
  decision_note: string | null;
  creation_idempotency_key: string;
  last_action_idempotency_key: string | null;
  last_action_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuoteEvent {
  id: string;
  account_id: string;
  quote_id: string;
  event_type: QuoteEventType;
  from_status: QuoteWorkflowStatus | null;
  to_status: QuoteWorkflowStatus;
  customer_decision: QuoteCustomerDecision | null;
  actor_user_id: string;
  idempotency_key: string;
  occurred_at: string;
}

/** A small learning-facing projection; it deliberately has no final amount. */
export interface CanonicalQuoteEvidence {
  aiSuggestionCount: number;
  humanApprovedQuoteCount: number;
  customerFacingQuoteCount: number;
  quoteDecision: QuoteCustomerDecision | null;
}

export class QuoteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuoteValidationError';
  }
}

const MAX_MINOR_AMOUNT = 999_999_999_999;
const MAX_LIST_ITEMS = 20;
const MAX_LIST_ITEM_LENGTH = 500;
const MAX_NOTES_LENGTH = 2_000;
const MAX_REFERENCE_LENGTH = 500;
const MAX_REASON_NOTE_LENGTH = 1_000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ORIGIN_SET = new Set<string>(QUOTE_ORIGINS);
const STATUS_SET = new Set<string>(QUOTE_WORKFLOW_STATUSES);
const DECISION_SET = new Set<string>(QUOTE_CUSTOMER_DECISIONS);
const AMOUNT_TYPE_SET = new Set<string>(QUOTE_AMOUNT_TYPES);
const OVERRIDE_REASON_SET = new Set<string>(QUOTE_OVERRIDE_REASONS);
const EVENT_SET = new Set<string>(QUOTE_EVENT_TYPES);

export function parseQuoteProposal(input: unknown): QuoteProposal {
  const record = requireRecord(input, 'Quote proposal must be an object');
  rejectUnknownKeys(record, [
    'currency',
    'amount_type',
    'fixed_amount_minor',
    'range_min_minor',
    'range_max_minor',
    'assumptions',
    'exclusions',
    'operator_notes',
    'source_reference',
    'source_observed_at',
    'override_reason',
    'override_reason_note',
  ]);

  const currency = requireString(record.currency, 'currency').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new QuoteValidationError('currency must be a three-letter code');
  }

  const amountType = readEnum(
    record.amount_type,
    AMOUNT_TYPE_SET,
    'amount_type',
    QUOTE_AMOUNT_TYPES
  );
  const fixed = readOptionalMinor(
    record.fixed_amount_minor,
    'fixed_amount_minor'
  );
  const minimum = readOptionalMinor(record.range_min_minor, 'range_min_minor');
  const maximum = readOptionalMinor(record.range_max_minor, 'range_max_minor');

  if (amountType === 'fixed') {
    if (fixed === null || minimum !== null || maximum !== null) {
      throw new QuoteValidationError(
        'A fixed quote requires fixed_amount_minor and no range amounts'
      );
    }
  } else {
    if (fixed !== null || minimum === null || maximum === null) {
      throw new QuoteValidationError(
        'A range quote requires range_min_minor and range_max_minor and no fixed amount'
      );
    }
    if (minimum > maximum) {
      throw new QuoteValidationError(
        'range_min_minor must be less than or equal to range_max_minor'
      );
    }
  }

  const overrideReason = readOptionalEnum(
    record.override_reason,
    OVERRIDE_REASON_SET,
    'override_reason',
    QUOTE_OVERRIDE_REASONS
  );

  return {
    currency,
    amount_type: amountType,
    fixed_amount_minor: fixed,
    range_min_minor: minimum,
    range_max_minor: maximum,
    assumptions: readStringList(record.assumptions, 'assumptions'),
    exclusions: readStringList(record.exclusions, 'exclusions'),
    operator_notes: readOptionalText(
      record.operator_notes,
      'operator_notes',
      MAX_NOTES_LENGTH
    ),
    source_reference: readOptionalText(
      record.source_reference,
      'source_reference',
      MAX_REFERENCE_LENGTH
    ),
    source_observed_at: readOptionalTimestamp(
      record.source_observed_at,
      'source_observed_at'
    ),
    override_reason: overrideReason,
    override_reason_note: readOptionalText(
      record.override_reason_note,
      'override_reason_note',
      MAX_REASON_NOTE_LENGTH
    ),
  };
}

export function parseQuote(value: unknown): Quote {
  const row = requireRecord(value, 'Quote row must be an object');
  const proposal = parseStoredProposal(row);
  const origin = readEnum(row.origin, ORIGIN_SET, 'origin', QUOTE_ORIGINS);
  const status = readEnum(
    row.status,
    STATUS_SET,
    'status',
    QUOTE_WORKFLOW_STATUSES
  );
  const customerDecision = readEnum(
    row.customer_decision,
    DECISION_SET,
    'customer_decision',
    QUOTE_CUSTOMER_DECISIONS
  );

  return {
    ...proposal,
    id: requireUuid(row.id, 'id'),
    account_id: requireUuid(row.account_id, 'account_id'),
    enquiry_id: requireUuid(row.enquiry_id, 'enquiry_id'),
    revision_number: requirePositiveInteger(
      row.revision_number,
      'revision_number'
    ),
    status,
    customer_decision: customerDecision,
    origin,
    supersedes_quote_id: readOptionalUuid(
      row.supersedes_quote_id,
      'supersedes_quote_id'
    ),
    superseded_by_quote_id: readOptionalUuid(
      row.superseded_by_quote_id,
      'superseded_by_quote_id'
    ),
    recommendation_quote_id: readOptionalUuid(
      row.recommendation_quote_id,
      'recommendation_quote_id'
    ),
    created_by_user_id: requireUuid(
      row.created_by_user_id,
      'created_by_user_id'
    ),
    approved_at: readOptionalTimestamp(row.approved_at, 'approved_at'),
    approved_by_user_id: readOptionalUuid(
      row.approved_by_user_id,
      'approved_by_user_id'
    ),
    presented_at: readOptionalTimestamp(row.presented_at, 'presented_at'),
    presented_by_user_id: readOptionalUuid(
      row.presented_by_user_id,
      'presented_by_user_id'
    ),
    decision_recorded_at: readOptionalTimestamp(
      row.decision_recorded_at,
      'decision_recorded_at'
    ),
    decision_recorded_by_user_id: readOptionalUuid(
      row.decision_recorded_by_user_id,
      'decision_recorded_by_user_id'
    ),
    decision_note: readOptionalText(
      row.decision_note,
      'decision_note',
      MAX_REASON_NOTE_LENGTH
    ),
    creation_idempotency_key: requireString(
      row.creation_idempotency_key,
      'creation_idempotency_key'
    ),
    last_action_idempotency_key: readOptionalText(
      row.last_action_idempotency_key,
      'last_action_idempotency_key',
      128
    ),
    last_action_by_user_id: readOptionalUuid(
      row.last_action_by_user_id,
      'last_action_by_user_id'
    ),
    created_at: requireTimestamp(row.created_at, 'created_at'),
    updated_at: requireTimestamp(row.updated_at, 'updated_at'),
  };
}

export function parseQuoteEvent(value: unknown): QuoteEvent {
  const row = requireRecord(value, 'Quote event row must be an object');
  return {
    id: requireUuid(row.id, 'id'),
    account_id: requireUuid(row.account_id, 'account_id'),
    quote_id: requireUuid(row.quote_id, 'quote_id'),
    event_type: readEnum(
      row.event_type,
      EVENT_SET,
      'event_type',
      QUOTE_EVENT_TYPES
    ),
    from_status: readOptionalEnum(
      row.from_status,
      STATUS_SET,
      'from_status',
      QUOTE_WORKFLOW_STATUSES
    ),
    to_status: readEnum(
      row.to_status,
      STATUS_SET,
      'to_status',
      QUOTE_WORKFLOW_STATUSES
    ),
    customer_decision: readOptionalEnum(
      row.customer_decision,
      DECISION_SET,
      'customer_decision',
      QUOTE_CUSTOMER_DECISIONS
    ),
    actor_user_id: requireUuid(row.actor_user_id, 'actor_user_id'),
    idempotency_key: requireString(row.idempotency_key, 'idempotency_key'),
    occurred_at: requireTimestamp(row.occurred_at, 'occurred_at'),
  };
}

export function quoteAmountsEqual(
  left: Pick<
    QuoteProposal,
    | 'currency'
    | 'amount_type'
    | 'fixed_amount_minor'
    | 'range_min_minor'
    | 'range_max_minor'
  >,
  right: Pick<
    QuoteProposal,
    | 'currency'
    | 'amount_type'
    | 'fixed_amount_minor'
    | 'range_min_minor'
    | 'range_max_minor'
  >
): boolean {
  return (
    left.currency === right.currency &&
    left.amount_type === right.amount_type &&
    left.fixed_amount_minor === right.fixed_amount_minor &&
    left.range_min_minor === right.range_min_minor &&
    left.range_max_minor === right.range_max_minor
  );
}

export function quoteEvidenceFromHistory(
  history: readonly Quote[]
): CanonicalQuoteEvidence {
  let aiSuggestionCount = 0;
  let humanApprovedQuoteCount = 0;
  let customerFacingQuoteCount = 0;
  let quoteDecision: QuoteCustomerDecision | null = null;

  const ordered = [...history].sort(
    (left, right) => left.revision_number - right.revision_number
  );
  for (const quote of ordered) {
    if (quote.origin === 'ai_suggested' || quote.origin === 'hybrid_engine') {
      aiSuggestionCount += 1;
    }
    if (quote.approved_at !== null) humanApprovedQuoteCount += 1;
    if (quote.presented_at !== null) customerFacingQuoteCount += 1;
    // The newest revision is the current commercial question. A prior
    // rejection remains in history, but it must not make a newer undecided
    // revision look rejected at case level.
    quoteDecision =
      quote.customer_decision === 'unknown' ? null : quote.customer_decision;
  }

  return {
    aiSuggestionCount,
    humanApprovedQuoteCount,
    customerFacingQuoteCount,
    quoteDecision,
  };
}

export function validateIdempotencyKey(value: unknown): string {
  const key = requireString(value, 'idempotency key');
  if (key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new QuoteValidationError(
      'idempotency key must be 1 to 128 URL-safe characters'
    );
  }
  return key;
}

function parseStoredProposal(row: Record<string, unknown>): QuoteProposal {
  return parseQuoteProposal({
    currency: row.currency,
    amount_type: row.amount_type,
    fixed_amount_minor: parseStoredMinor(row.fixed_amount_minor),
    range_min_minor: parseStoredMinor(row.range_min_minor),
    range_max_minor: parseStoredMinor(row.range_max_minor),
    assumptions: row.assumptions,
    exclusions: row.exclusions,
    operator_notes: row.operator_notes,
    source_reference: row.source_reference,
    source_observed_at: row.source_observed_at,
    override_reason: row.override_reason,
    override_reason_note: row.override_reason_note,
  });
}

function parseStoredMinor(value: unknown): unknown {
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return value;
}

function readOptionalMinor(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_MINOR_AMOUNT
  ) {
    throw new QuoteValidationError(
      `${field} must be a non-negative safe integer in minor currency units`
    );
  }
  return value;
}

function readStringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new QuoteValidationError(
      `${field} must be an array of at most ${MAX_LIST_ITEMS} strings`
    );
  }
  return value.map((item, index) => {
    const text = requireString(item, `${field}[${index}]`);
    if (text.length > MAX_LIST_ITEM_LENGTH) {
      throw new QuoteValidationError(
        `${field}[${index}] must be at most ${MAX_LIST_ITEM_LENGTH} characters`
      );
    }
    return text;
  });
}

function readOptionalText(
  value: unknown,
  field: string,
  maximum: number
): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, field);
  if (text.length > maximum) {
    throw new QuoteValidationError(
      `${field} must be at most ${maximum} characters`
    );
  }
  return text;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new QuoteValidationError(`${field} is required`);
  }
  return value.trim();
}

function requireUuid(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (!UUID_RE.test(id))
    throw new QuoteValidationError(`${field} must be a UUID`);
  return id;
}

function readOptionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return requireUuid(value, field);
}

function requirePositiveInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 1) {
    throw new QuoteValidationError(`${field} must be a positive integer`);
  }
  return parsed;
}

function requireTimestamp(value: unknown, field: string): string {
  const timestamp = requireString(value, field);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new QuoteValidationError(`${field} must be an ISO timestamp`);
  }
  return new Date(timestamp).toISOString();
}

function readOptionalTimestamp(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return requireTimestamp(value, field);
}

function readEnum<T extends string>(
  value: unknown,
  set: ReadonlySet<string>,
  field: string,
  choices: readonly T[]
): T {
  if (typeof value !== 'string' || !set.has(value)) {
    throw new QuoteValidationError(
      `${field} must be one of: ${choices.join(', ')}`
    );
  }
  return value as T;
}

function readOptionalEnum<T extends string>(
  value: unknown,
  set: ReadonlySet<string>,
  field: string,
  choices: readonly T[]
): T | null {
  if (value === undefined || value === null) return null;
  return readEnum(value, set, field, choices);
}

function requireRecord(
  value: unknown,
  message: string
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new QuoteValidationError(message);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[]
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new QuoteValidationError(
      `Unknown quote fields: ${unknown.join(', ')}`
    );
  }
}
