import type { SupabaseClient } from '@supabase/supabase-js';

import {
  ACTIVE_ENQUIRY_STATES,
  TERMINAL_ENQUIRY_STATES,
  parseEnquiry,
  type Enquiry,
  type EnquiryFacts,
} from '@/lib/enquiries/model';
import { ENQUIRY_COLUMNS } from '@/lib/enquiries/repository';

import { ToolError } from './contract';

export const MAX_ENQUIRY_STRING_CHARS = 500;
export const MAX_ENQUIRY_LIST_ITEMS = 20;

export interface ToolEnquiryContext {
  id: string;
  workflow_state: Enquiry['workflow_state'];
  facts: EnquiryFacts;
  state_changed_at: string;
  created_at: string;
  updated_at: string;
  truncated_fields: string[];
}

export async function loadActiveEnquiry(
  db: SupabaseClient,
  accountId: string,
  conversationId: string
): Promise<Enquiry | null> {
  const { data, error } = await db
    .from('enquiries')
    .select(ENQUIRY_COLUMNS)
    .eq('account_id', accountId)
    .eq('conversation_id', conversationId)
    .in('workflow_state', [...ACTIVE_ENQUIRY_STATES])
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw unavailable('Could not load active enquiry');
  return data ? parseEnquiry(data) : null;
}

export async function loadHistoricalEnquiries(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  limit: number
): Promise<{ enquiries: Enquiry[]; truncated: boolean }> {
  const { data, error } = await db
    .from('enquiries')
    .select(ENQUIRY_COLUMNS)
    .eq('account_id', accountId)
    .eq('conversation_id', conversationId)
    .in('workflow_state', [...TERMINAL_ENQUIRY_STATES])
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);

  if (error) throw unavailable('Could not load enquiry history');
  const rows = data ?? [];
  return {
    enquiries: rows.slice(0, limit).map(parseEnquiry),
    truncated: rows.length > limit,
  };
}

export function toToolEnquiryContext(enquiry: Enquiry): ToolEnquiryContext {
  const truncatedFields = new Set<string>();
  const boundedString = (value: string | null, field: string) =>
    truncateNullable(value, MAX_ENQUIRY_STRING_CHARS, field, truncatedFields);
  const boundedList = (value: string[] | null, field: string) =>
    truncateNullableList(value, field, truncatedFields);

  return {
    id: enquiry.id,
    workflow_state: enquiry.workflow_state,
    facts: {
      customer_intent: boundedString(
        enquiry.customer_intent,
        'customer_intent'
      ),
      postcode: boundedString(enquiry.postcode, 'postcode'),
      address: boundedString(enquiry.address, 'address'),
      property_type: boundedString(enquiry.property_type, 'property_type'),
      floor: boundedString(enquiry.floor, 'floor'),
      lift_available: enquiry.lift_available,
      parking: boundedString(enquiry.parking, 'parking'),
      access_constraints: boundedList(
        enquiry.access_constraints,
        'access_constraints'
      ),
      item_descriptions: boundedList(
        enquiry.item_descriptions,
        'item_descriptions'
      ),
      waste_type: boundedString(enquiry.waste_type, 'waste_type'),
      estimated_volume: boundedString(
        enquiry.estimated_volume,
        'estimated_volume'
      ),
      heavy_special_items: boundedList(
        enquiry.heavy_special_items,
        'heavy_special_items'
      ),
      photos_received: enquiry.photos_received,
      preferred_date: enquiry.preferred_date,
      preferred_time_window: boundedString(
        enquiry.preferred_time_window,
        'preferred_time_window'
      ),
      missing_information: [...enquiry.missing_information],
    },
    state_changed_at: enquiry.state_changed_at,
    created_at: enquiry.created_at,
    updated_at: enquiry.updated_at,
    truncated_fields: [...truncatedFields],
  };
}

export function unavailable(message: string): ToolError {
  return new ToolError('unavailable', message, { retryable: true });
}

export function parseRequiredId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolError('invalid_input', `${field} is required`);
  }
  return value.trim();
}

export function parseOptionalId(
  value: unknown,
  field: string
): string | undefined {
  if (value === undefined) return undefined;
  return parseRequiredId(value, field);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function truncateNullable(
  value: string | null,
  maxChars: number,
  field: string,
  truncatedFields: Set<string>
): string | null {
  if (value === null) return null;
  if (value.length <= maxChars) return value;
  truncatedFields.add(field);
  return value.slice(0, maxChars);
}

function truncateNullableList(
  value: string[] | null,
  field: string,
  truncatedFields: Set<string>
): string[] | null {
  if (value === null) return null;
  if (value.length > MAX_ENQUIRY_LIST_ITEMS) truncatedFields.add(field);
  return value.slice(0, MAX_ENQUIRY_LIST_ITEMS).map((entry) => {
    if (entry.length > MAX_ENQUIRY_STRING_CHARS) truncatedFields.add(field);
    return entry.slice(0, MAX_ENQUIRY_STRING_CHARS);
  });
}
