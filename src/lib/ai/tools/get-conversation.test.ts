import { describe, expect, it } from 'vitest';

import {
  GET_CONVERSATION_DEFAULT_MESSAGE_LIMIT,
  GET_CONVERSATION_ENQUIRY_TRANSITION_LIMIT,
  GET_CONVERSATION_MAX_MESSAGE_CHARS,
  getConversationTool,
} from './get-conversation';
import { enquiryRow, fakeToolDatabase, toolContext } from './test-support';

const CONTACT = {
  id: 'contact-1',
  account_id: 'account-1',
  name: 'Ada Customer',
  phone: '447700900123',
  wa_user_id: 'wa-1',
  wa_parent_user_id: null,
  wa_username: 'ada',
};

const CONVERSATION = {
  id: 'conversation-1',
  account_id: 'account-1',
  contact_id: 'contact-1',
  status: 'open',
  updated_at: '2026-10-01T10:00:00.000Z',
};

function message(
  id: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    conversation_id: 'conversation-1',
    sender_type: 'customer',
    content_type: 'text',
    content_text: id,
    media_url: null,
    media_type: null,
    status: 'delivered',
    created_at: '2026-10-01T10:00:00.000Z',
    reply_to_message_id: null,
    interactive_reply_id: null,
    ai_generated: false,
    ...overrides,
  };
}

function stateEvent(
  id: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    account_id: 'account-1',
    enquiry_id: 'enquiry-1',
    from_state: null,
    to_state: 'new_enquiry',
    changed_by_user_id: null,
    changed_at: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

describe('get_conversation', () => {
  it('returns a chronological, directional conversation context', async () => {
    const fake = fakeToolDatabase({
      contacts: [CONTACT],
      conversations: [CONVERSATION],
      messages: [
        message('message-1', {
          created_at: '2026-10-01T10:00:00.000Z',
          sender_type: 'customer',
          content_text: 'Can you collect this?',
        }),
        message('message-2', {
          created_at: '2026-10-01T10:01:00.000Z',
          sender_type: 'agent',
          content_text: 'Yes.',
        }),
      ],
    });

    const result = await getConversationTool.execute(toolContext(fake.db), {
      conversation_id: 'conversation-1',
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        conversation_id: 'conversation-1',
        customer: { contact_id: 'contact-1', name: 'Ada Customer' },
        recent_messages: [
          {
            id: 'message-1',
            direction: 'inbound',
            content_text: 'Can you collect this?',
          },
          {
            id: 'message-2',
            direction: 'outbound',
            content_text: 'Yes.',
          },
        ],
        active_enquiry: null,
      },
    });
  });

  it('uses created_at then id for deterministic bounded ordering', async () => {
    const fake = fakeToolDatabase({
      contacts: [CONTACT],
      conversations: [CONVERSATION],
      messages: [
        message('message-1'),
        message('message-3'),
        message('message-2'),
      ],
    });

    const result = await getConversationTool.execute(toolContext(fake.db), {
      conversation_id: 'conversation-1',
      recent_message_limit: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.recent_messages.map((item) => item.id)).toEqual([
      'message-2',
      'message-3',
    ]);
    expect(result.data.context_window).toMatchObject({
      message_limit: 2,
      returned_messages: 2,
      has_earlier_messages: true,
    });
  });

  it('bounds long conversations and truncates oversized message text', async () => {
    const messages = Array.from({ length: 60 }, (_, index) =>
      message(`message-${String(index).padStart(2, '0')}`, {
        created_at: `2026-10-01T10:${String(index).padStart(2, '0')}:00.000Z`,
        content_text:
          index === 59
            ? 'x'.repeat(GET_CONVERSATION_MAX_MESSAGE_CHARS + 50)
            : `message ${index}`,
      })
    );
    const fake = fakeToolDatabase({
      contacts: [CONTACT],
      conversations: [CONVERSATION],
      messages,
    });

    const result = await getConversationTool.execute(toolContext(fake.db), {
      conversation_id: 'conversation-1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.recent_messages).toHaveLength(
      GET_CONVERSATION_DEFAULT_MESSAGE_LIMIT
    );
    expect(result.data.context_window.has_earlier_messages).toBe(true);
    expect(result.data.recent_messages.at(-1)).toMatchObject({
      content_truncated: true,
    });
    expect(result.data.recent_messages.at(-1)?.content_text).toHaveLength(
      GET_CONVERSATION_MAX_MESSAGE_CHARS
    );
  });

  it('preserves media-only messages without inventing text', async () => {
    const fake = fakeToolDatabase({
      contacts: [CONTACT],
      conversations: [CONVERSATION],
      messages: [
        message('image-1', {
          content_type: 'image',
          content_text: null,
          media_url: '/api/whatsapp/media/media-1',
          media_type: 'image/jpeg',
        }),
      ],
    });

    const result = await getConversationTool.execute(toolContext(fake.db), {
      conversation_id: 'conversation-1',
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        recent_messages: [
          {
            content_type: 'image',
            content_text: null,
            media: {
              reference: '/api/whatsapp/media/media-1',
              reference_truncated: false,
              mime_type: 'image/jpeg',
            },
          },
        ],
      },
    });
  });

  it('returns an empty bounded window and no enquiry when neither exists', async () => {
    const fake = fakeToolDatabase({
      contacts: [CONTACT],
      conversations: [CONVERSATION],
    });

    const result = await getConversationTool.execute(toolContext(fake.db), {
      conversation_id: 'conversation-1',
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        recent_messages: [],
        active_enquiry: null,
        context_window: {
          returned_messages: 0,
          has_earlier_messages: false,
        },
      },
    });
  });

  it('includes durable active-enquiry facts and missing_information', async () => {
    const fake = fakeToolDatabase({
      contacts: [CONTACT],
      conversations: [CONVERSATION],
      enquiries: [
        enquiryRow({
          workflow_state: 'awaiting_photos',
          item_descriptions: ['Sofa', 'Table'],
          photos_received: false,
          missing_information: ['postcode', 'photos_received'],
        }),
      ],
    });

    const result = await getConversationTool.execute(toolContext(fake.db), {
      conversation_id: 'conversation-1',
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        active_enquiry: {
          workflow_state: 'awaiting_photos',
          facts: {
            item_descriptions: ['Sofa', 'Table'],
            photos_received: false,
            missing_information: ['postcode', 'photos_received'],
          },
        },
      },
    });
  });

  it('returns no state transitions when no canonical events exist', async () => {
    const fake = fakeToolDatabase({
      contacts: [CONTACT],
      conversations: [CONVERSATION],
    });

    const result = await getConversationTool.execute(toolContext(fake.db), {
      conversation_id: 'conversation-1',
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        enquiry_recent_transitions: [],
        context_window: {
          enquiry_transition_limit: GET_CONVERSATION_ENQUIRY_TRANSITION_LIMIT,
          returned_enquiry_transitions: 0,
          has_earlier_enquiry_transitions: false,
        },
      },
    });
  });

  it('returns one canonical transition and preserves a null actor', async () => {
    const fake = fakeToolDatabase({
      contacts: [CONTACT],
      conversations: [CONVERSATION],
      enquiries: [enquiryRow({ workflow_state: 'completed' })],
      enquiry_state_events: [stateEvent('event-1')],
    });

    const result = await getConversationTool.execute(toolContext(fake.db), {
      conversation_id: 'conversation-1',
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        enquiry_recent_transitions: [
          {
            enquiry_id: 'enquiry-1',
            previous_state: null,
            new_state: 'new_enquiry',
            changed_at: '2026-10-01T09:00:00.000Z',
            changed_by_user_id: null,
          },
        ],
      },
    });
  });

  it('bounds transitions and orders timestamp ties by id deterministically', async () => {
    const events = Array.from(
      { length: GET_CONVERSATION_ENQUIRY_TRANSITION_LIMIT + 3 },
      (_, index) => {
        const suffix = String(index + 1).padStart(2, '0');
        return stateEvent(`event-${suffix}`, {
          changed_at: '2026-10-01T09:00:00.000Z',
          changed_by_user_id: `user-${suffix}`,
        });
      }
    ).reverse();
    const fake = fakeToolDatabase({
      contacts: [CONTACT],
      conversations: [CONVERSATION],
      enquiries: [enquiryRow()],
      enquiry_state_events: events,
    });

    const first = await getConversationTool.execute(toolContext(fake.db), {
      conversation_id: 'conversation-1',
    });
    const second = await getConversationTool.execute(toolContext(fake.db), {
      conversation_id: 'conversation-1',
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.data.enquiry_recent_transitions).toEqual(
      first.data.enquiry_recent_transitions
    );
    expect(first.data.enquiry_recent_transitions).toHaveLength(
      GET_CONVERSATION_ENQUIRY_TRANSITION_LIMIT
    );
    expect(
      first.data.enquiry_recent_transitions.map(
        (transition) => transition.changed_by_user_id
      )
    ).toEqual(
      Array.from(
        { length: GET_CONVERSATION_ENQUIRY_TRANSITION_LIMIT },
        (_, index) => `user-${String(index + 4).padStart(2, '0')}`
      )
    );
    expect(first.data.context_window.has_earlier_enquiry_transitions).toBe(
      true
    );
  });

  it('account-scopes enquiry and state-event history', async () => {
    const fake = fakeToolDatabase({
      contacts: [CONTACT],
      conversations: [CONVERSATION],
      enquiries: [
        enquiryRow({ workflow_state: 'completed' }),
        enquiryRow({
          id: 'enquiry-foreign',
          account_id: 'account-2',
          workflow_state: 'cancelled',
        }),
      ],
      enquiry_state_events: [
        stateEvent('event-own'),
        stateEvent('event-foreign', {
          account_id: 'account-2',
          enquiry_id: 'enquiry-foreign',
          to_state: 'cancelled',
        }),
      ],
    });

    const result = await getConversationTool.execute(toolContext(fake.db), {
      conversation_id: 'conversation-1',
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        enquiry_recent_transitions: [
          expect.objectContaining({ enquiry_id: 'enquiry-1' }),
        ],
      },
    });
    const eventCall = fake.calls.find(
      (call) => call.table === 'enquiry_state_events'
    );
    expect(eventCall?.filters).toEqual(
      expect.arrayContaining([
        { kind: 'eq', column: 'account_id', value: 'account-1' },
      ])
    );
  });

  it('denies a cross-account conversation before reading child messages', async () => {
    const fake = fakeToolDatabase({
      contacts: [{ ...CONTACT, account_id: 'account-2' }],
      conversations: [{ ...CONVERSATION, account_id: 'account-2' }],
      messages: [message('foreign-message')],
    });

    const result = await getConversationTool.execute(toolContext(fake.db), {
      conversation_id: 'conversation-1',
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      table: 'conversations',
      filters: expect.arrayContaining([
        { kind: 'eq', column: 'account_id', value: 'account-1' },
      ]),
    });
  });
});
