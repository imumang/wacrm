/**
 * Canonical-shaped seed rows for the tool tests.
 *
 * Values mirror the real column set and types rather than being minimal:
 * `parseEnquiry` rejects a row that is missing any fact field, so a partial
 * fixture would fail for the wrong reason. Kept in one place so the three
 * test files describe the same world.
 */

import type { Enquiry, EnquiryFacts } from '@/lib/enquiries/model';

import type { SeedRow } from './fake-db';

type Row = SeedRow;

export const ACCOUNT = 'account-1';
export const OTHER_ACCOUNT = 'account-2';
export const CONTACT_ID = 'contact-1';
export const CONVERSATION_ID = 'conversation-1';

export const NULL_FACTS: EnquiryFacts = {
  customer_intent: null,
  postcode: null,
  address: null,
  property_type: null,
  floor: null,
  lift_available: null,
  parking: null,
  access_constraints: null,
  item_descriptions: null,
  waste_type: null,
  estimated_volume: null,
  heavy_special_items: null,
  photos_received: null,
  preferred_date: null,
  preferred_time_window: null,
  missing_information: [],
};

export function makeEnquiry(overrides: Partial<Enquiry> = {}): Enquiry {
  return {
    id: 'enquiry-1',
    account_id: ACCOUNT,
    conversation_id: CONVERSATION_ID,
    created_by_user_id: 'user-1',
    workflow_state: 'new_enquiry',
    ...NULL_FACTS,
    state_changed_at: '2026-10-01T09:00:00.000Z',
    created_at: '2026-10-01T09:00:00.000Z',
    updated_at: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

export function contactRow(overrides: Record<string, unknown> = {}): SeedRow {
  return {
    id: CONTACT_ID,
    account_id: ACCOUNT,
    name: 'Ada Lovelace',
    phone: '+447700900123',
    wa_user_id: 'US.13491208655302741918',
    wa_parent_user_id: 'US.ENT.11815799212886844830',
    wa_username: null,
    created_at: '2026-09-01T09:00:00.000Z',
    updated_at: '2026-09-20T09:00:00.000Z',
    ...overrides,
  };
}

export function conversationRow(
  overrides: Record<string, unknown> = {}
): SeedRow {
  return {
    id: CONVERSATION_ID,
    account_id: ACCOUNT,
    contact_id: CONTACT_ID,
    status: 'open',
    created_at: '2026-09-01T09:00:00.000Z',
    updated_at: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

export function messageRow(
  index: number,
  overrides: Record<string, unknown> = {}
): SeedRow {
  return {
    id: `message-${String(index).padStart(3, '0')}`,
    conversation_id: CONVERSATION_ID,
    // Direction is always asserted explicitly in a test; the fixture never
    // guesses a sender from the row index.
    sender_type: 'customer',
    content_type: 'text',
    content_text: `message ${index}`,
    media_url: null,
    media_type: null,
    status: 'delivered',
    created_at: `2026-10-01T09:${String(index % 60).padStart(2, '0')}:00.000Z`,
    reply_to_message_id: null,
    interactive_reply_id: null,
    ai_generated: false,
    ...overrides,
  };
}

/** A seed where the account has one contact, one conversation, no enquiries. */
export function baseSeed(): Record<string, Row[]> {
  return {
    contacts: [contactRow()],
    conversations: [conversationRow()],
    enquiries: [],
    contact_notes: [],
    contact_tags: [],
    tags: [],
    messages: [],
  };
}
