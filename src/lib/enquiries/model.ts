export const ENQUIRY_WORKFLOW_STATES = [
  'new_enquiry',
  'gathering_information',
  'awaiting_photos',
  'ready_for_quote',
  'quote_draft',
  'quote_sent',
  'awaiting_acceptance',
  'booking_requested',
  'booked',
  'reschedule_requested',
  'cancelled',
  'completed',
] as const;

export type EnquiryWorkflowState = (typeof ENQUIRY_WORKFLOW_STATES)[number];

export const INITIAL_ENQUIRY_STATE: EnquiryWorkflowState = 'new_enquiry';

export const TERMINAL_ENQUIRY_STATES = ['cancelled', 'completed'] as const;

export const ACTIVE_ENQUIRY_STATES = ENQUIRY_WORKFLOW_STATES.filter(
  (state) =>
    !TERMINAL_ENQUIRY_STATES.includes(state as 'cancelled' | 'completed')
);

export const ENQUIRY_MISSING_INFORMATION_FIELDS = [
  'customer_intent',
  'customer_name',
  'phone',
  'postcode',
  'address',
  'property_type',
  'floor',
  'lift_availability',
  'parking',
  'access_constraints',
  'item_descriptions',
  'waste_type',
  'estimated_volume',
  'heavy_special_items',
  'photos_received',
  'preferred_date',
  'preferred_time_window',
] as const;

export type EnquiryMissingInformation =
  (typeof ENQUIRY_MISSING_INFORMATION_FIELDS)[number];

export interface EnquiryFacts {
  customer_intent: string | null;
  postcode: string | null;
  address: string | null;
  property_type: string | null;
  floor: string | null;
  lift_available: boolean | null;
  parking: string | null;
  access_constraints: string[] | null;
  item_descriptions: string[] | null;
  waste_type: string | null;
  estimated_volume: string | null;
  heavy_special_items: string[] | null;
  photos_received: boolean | null;
  preferred_date: string | null;
  preferred_time_window: string | null;
  missing_information: EnquiryMissingInformation[];
}

export type EnquiryFactsPatch = Partial<EnquiryFacts>;

export interface Enquiry extends EnquiryFacts {
  id: string;
  account_id: string;
  conversation_id: string;
  created_by_user_id: string | null;
  workflow_state: EnquiryWorkflowState;
  state_changed_at: string;
  created_at: string;
  updated_at: string;
}

/**
 * Name and phone stay canonical on contacts. This composed shape lets a
 * future get_conversation tool expose them with enquiry facts without
 * copying values into the enquiries table.
 */
export interface EnquiryContext extends Enquiry {
  customer: {
    name: string | null;
    phone: string | null;
  };
}

export interface EnquiryStateEvent {
  id: string;
  account_id: string;
  enquiry_id: string;
  from_state: EnquiryWorkflowState | null;
  to_state: EnquiryWorkflowState;
  changed_by_user_id: string | null;
  changed_at: string;
}

const TRANSITIONS: Readonly<
  Record<EnquiryWorkflowState, readonly EnquiryWorkflowState[]>
> = {
  new_enquiry: [
    'gathering_information',
    'awaiting_photos',
    'ready_for_quote',
    'cancelled',
  ],
  gathering_information: ['awaiting_photos', 'ready_for_quote', 'cancelled'],
  awaiting_photos: ['gathering_information', 'ready_for_quote', 'cancelled'],
  ready_for_quote: [
    'gathering_information',
    'awaiting_photos',
    'quote_draft',
    'cancelled',
  ],
  quote_draft: [
    'gathering_information',
    'awaiting_photos',
    'ready_for_quote',
    'quote_sent',
    'cancelled',
  ],
  quote_sent: [
    'quote_draft',
    'awaiting_acceptance',
    'booking_requested',
    'cancelled',
  ],
  awaiting_acceptance: ['quote_draft', 'booking_requested', 'cancelled'],
  booking_requested: ['booked', 'cancelled'],
  booked: ['reschedule_requested', 'cancelled', 'completed'],
  reschedule_requested: ['booked', 'cancelled'],
  cancelled: [],
  completed: [],
};

const WORKFLOW_STATE_SET = new Set<string>(ENQUIRY_WORKFLOW_STATES);
const MISSING_FIELD_SET = new Set<string>(ENQUIRY_MISSING_INFORMATION_FIELDS);

const STRING_FACT_FIELDS = [
  'customer_intent',
  'postcode',
  'address',
  'property_type',
  'floor',
  'parking',
  'waste_type',
  'estimated_volume',
  'preferred_time_window',
] as const satisfies readonly (keyof EnquiryFacts)[];

const STRING_ARRAY_FACT_FIELDS = [
  'access_constraints',
  'item_descriptions',
  'heavy_special_items',
] as const satisfies readonly (keyof EnquiryFacts)[];

const FACT_FIELD_SET = new Set<string>([
  ...STRING_FACT_FIELDS,
  ...STRING_ARRAY_FACT_FIELDS,
  'lift_available',
  'photos_received',
  'preferred_date',
  'missing_information',
]);

export class EnquiryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnquiryValidationError';
  }
}

export class InvalidEnquiryTransitionError extends Error {
  readonly from: EnquiryWorkflowState;
  readonly to: EnquiryWorkflowState;

  constructor(from: EnquiryWorkflowState, to: EnquiryWorkflowState) {
    super(`Invalid enquiry state transition: ${from} -> ${to}`);
    this.name = 'InvalidEnquiryTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function isEnquiryWorkflowState(
  value: unknown
): value is EnquiryWorkflowState {
  return typeof value === 'string' && WORKFLOW_STATE_SET.has(value);
}

export function isValidEnquiryTransition(
  from: EnquiryWorkflowState,
  to: EnquiryWorkflowState
): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertValidEnquiryTransition(
  from: EnquiryWorkflowState,
  to: EnquiryWorkflowState
): void {
  if (!isValidEnquiryTransition(from, to)) {
    throw new InvalidEnquiryTransitionError(from, to);
  }
}

export function parseEnquiryFactsPatch(input: unknown): EnquiryFactsPatch {
  if (!isRecord(input)) {
    throw new EnquiryValidationError('Enquiry facts must be an object');
  }

  for (const key of Object.keys(input)) {
    if (!FACT_FIELD_SET.has(key)) {
      throw new EnquiryValidationError(`Unknown enquiry fact: ${key}`);
    }
  }

  const result: EnquiryFactsPatch = {};

  for (const field of STRING_FACT_FIELDS) {
    if (field in input) {
      result[field] = parseNullableString(input[field], field);
    }
  }

  for (const field of STRING_ARRAY_FACT_FIELDS) {
    if (field in input) {
      result[field] = parseNullableStringArray(input[field], field);
    }
  }

  if ('lift_available' in input) {
    result.lift_available = parseNullableBoolean(
      input.lift_available,
      'lift_available'
    );
  }

  if ('photos_received' in input) {
    result.photos_received = parseNullableBoolean(
      input.photos_received,
      'photos_received'
    );
  }

  if ('preferred_date' in input) {
    result.preferred_date = parseNullableDate(input.preferred_date);
  }

  if ('missing_information' in input) {
    result.missing_information = parseMissingInformation(
      input.missing_information
    );
  }

  return result;
}

export function parseEnquiry(input: unknown): Enquiry {
  if (!isRecord(input)) {
    throw new EnquiryValidationError('Enquiry must be an object');
  }

  const workflowState = input.workflow_state;
  if (!isEnquiryWorkflowState(workflowState)) {
    throw new EnquiryValidationError('Invalid enquiry workflow_state');
  }

  const facts = parseEnquiryFactsPatch(
    Object.fromEntries(
      Object.entries(input).filter(([key]) => FACT_FIELD_SET.has(key))
    )
  );

  for (const field of FACT_FIELD_SET) {
    if (!(field in facts)) {
      throw new EnquiryValidationError(`Missing enquiry field: ${field}`);
    }
  }

  return {
    id: parseRequiredString(input.id, 'id'),
    account_id: parseRequiredString(input.account_id, 'account_id'),
    conversation_id: parseRequiredString(
      input.conversation_id,
      'conversation_id'
    ),
    created_by_user_id:
      input.created_by_user_id === null
        ? null
        : parseRequiredString(input.created_by_user_id, 'created_by_user_id'),
    workflow_state: workflowState,
    customer_intent: facts.customer_intent ?? null,
    postcode: facts.postcode ?? null,
    address: facts.address ?? null,
    property_type: facts.property_type ?? null,
    floor: facts.floor ?? null,
    lift_available: facts.lift_available ?? null,
    parking: facts.parking ?? null,
    access_constraints: facts.access_constraints ?? null,
    item_descriptions: facts.item_descriptions ?? null,
    waste_type: facts.waste_type ?? null,
    estimated_volume: facts.estimated_volume ?? null,
    heavy_special_items: facts.heavy_special_items ?? null,
    photos_received: facts.photos_received ?? null,
    preferred_date: facts.preferred_date ?? null,
    preferred_time_window: facts.preferred_time_window ?? null,
    missing_information: facts.missing_information ?? [],
    state_changed_at: parseRequiredString(
      input.state_changed_at,
      'state_changed_at'
    ),
    created_at: parseRequiredString(input.created_at, 'created_at'),
    updated_at: parseRequiredString(input.updated_at, 'updated_at'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new EnquiryValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

function parseNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return parseRequiredString(value, field).trim();
}

function parseNullableStringArray(
  value: unknown,
  field: string
): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new EnquiryValidationError(`${field} must be an array or null`);
  }

  return unique(
    value.map((entry, index) =>
      parseRequiredString(entry, `${field}[${index}]`).trim()
    )
  );
}

function parseNullableBoolean(value: unknown, field: string): boolean | null {
  if (value === null || typeof value === 'boolean') return value;
  throw new EnquiryValidationError(`${field} must be a boolean or null`);
}

function parseNullableDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new EnquiryValidationError(
      'preferred_date must be an ISO date (YYYY-MM-DD) or null'
    );
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new EnquiryValidationError('preferred_date must be a valid date');
  }
  return value;
}

function parseMissingInformation(value: unknown): EnquiryMissingInformation[] {
  if (!Array.isArray(value)) {
    throw new EnquiryValidationError('missing_information must be an array');
  }

  const fields = value.map((entry) => {
    if (typeof entry !== 'string' || !MISSING_FIELD_SET.has(entry)) {
      throw new EnquiryValidationError(
        `Invalid missing-information field: ${String(entry)}`
      );
    }
    return entry as EnquiryMissingInformation;
  });

  return unique(fields);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
