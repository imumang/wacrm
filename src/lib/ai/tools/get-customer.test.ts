import { describe, expect, it } from 'vitest';

import {
  GET_CUSTOMER_MAX_HISTORICAL_ENQUIRIES,
  getCustomerTool,
} from './get-customer';
import { enquiryRow, fakeToolDatabase, toolContext } from './test-support';

const CONTACT = {
  id: 'contact-1',
  account_id: 'account-1',
  name: 'Ada Customer',
  phone: '447700900123',
  wa_user_id: 'wa-1',
  wa_parent_user_id: null,
  wa_username: 'ada',
  updated_at: '2026-10-01T08:00:00.000Z',
};

const CONVERSATION = {
  id: 'conversation-1',
  account_id: 'account-1',
  contact_id: 'contact-1',
  created_at: '2026-09-01T08:00:00.000Z',
};

describe('get_customer', () => {
  it('returns bounded customer, tag, note, and active-enquiry context', async () => {
    const fake = fakeToolDatabase({
      contacts: [CONTACT],
      conversations: [CONVERSATION],
      contact_tags: [
        {
          id: 'join-1',
          tag_id: 'tag-1',
          contact_id: 'contact-1',
          created_at: '1',
        },
      ],
      tags: [
        { id: 'tag-1', account_id: 'account-1', name: 'VIP', color: '#123456' },
      ],
      contact_notes: [
        {
          id: 'note-1',
          account_id: 'account-1',
          contact_id: 'contact-1',
          note_text: 'Call before arrival',
          created_at: '2026-09-30T10:00:00.000Z',
        },
      ],
      enquiries: [
        enquiryRow({
          workflow_state: 'gathering_information',
          address: '1 Example Road',
          postcode: 'SW1A 1AA',
          customer_intent: 'House clearance',
          missing_information: ['photos_received'],
        }),
      ],
    });

    const result = await getCustomerTool.execute(toolContext(fake.db), {
      conversation_id: 'conversation-1',
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        customer_id: 'contact-1',
        conversation_id: 'conversation-1',
        name: 'Ada Customer',
        phone: '447700900123',
        whatsapp_identity: {
          wa_user_id: 'wa-1',
          wa_parent_user_id: null,
          wa_username: 'ada',
        },
        address: '1 Example Road',
        postcode: 'SW1A 1AA',
        tags: [{ id: 'tag-1', name: 'VIP', color: '#123456' }],
        notes: [expect.objectContaining({ text: 'Call before arrival' })],
        active_enquiry: {
          workflow_state: 'gathering_information',
          facts: expect.objectContaining({
            customer_intent: 'House clearance',
            missing_information: ['photos_received'],
          }),
        },
      },
    });
  });

  it('returns not_found for a missing customer', async () => {
    const fake = fakeToolDatabase();

    await expect(
      getCustomerTool.execute(toolContext(fake.db), { contact_id: 'missing' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_found', message: 'Customer not found' },
    });
  });

  it('keeps unknown values explicit', async () => {
    const fake = fakeToolDatabase({
      contacts: [
        {
          ...CONTACT,
          name: null,
          phone: '',
          wa_user_id: null,
          wa_username: null,
        },
      ],
      conversations: [],
    });

    const result = await getCustomerTool.execute(toolContext(fake.db), {
      contact_id: 'contact-1',
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        name: null,
        phone: null,
        address: null,
        postcode: null,
        active_enquiry: null,
        previous_enquiries: [],
        whatsapp_identity: {
          wa_user_id: null,
          wa_parent_user_id: null,
          wa_username: null,
        },
      },
    });
  });

  it('returns only the newest bounded completed/cancelled enquiry history', async () => {
    const history = Array.from({ length: 5 }, (_, index) =>
      enquiryRow({
        id: `history-${index + 1}`,
        workflow_state: index % 2 === 0 ? 'completed' : 'cancelled',
        created_at: `2026-09-0${index + 1}T09:00:00.000Z`,
        updated_at: `2026-09-0${index + 1}T09:00:00.000Z`,
      })
    );
    const fake = fakeToolDatabase({
      contacts: [CONTACT],
      conversations: [CONVERSATION],
      enquiries: history,
    });

    const result = await getCustomerTool.execute(toolContext(fake.db), {
      contact_id: 'contact-1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.previous_enquiries.map((item) => item.id)).toEqual([
      'history-5',
      'history-4',
      'history-3',
    ]);
    expect(result.data.previous_enquiries).toHaveLength(
      GET_CUSTOMER_MAX_HISTORICAL_ENQUIRIES
    );
    expect(result.data.bounds.historical_enquiries_truncated).toBe(true);
  });

  it('denies a cross-account customer without revealing that it exists', async () => {
    const fake = fakeToolDatabase({
      contacts: [{ ...CONTACT, account_id: 'account-2' }],
    });

    const result = await getCustomerTool.execute(toolContext(fake.db), {
      contact_id: 'contact-1',
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(fake.calls[0]).toMatchObject({
      table: 'contacts',
      filters: expect.arrayContaining([
        { kind: 'eq', column: 'account_id', value: 'account-1' },
      ]),
    });
  });
});
