import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'

import {
  afterInboundInsert,
  contactIdentityPatch,
  hasUsableInboundIdentity,
  persistInboundMessage,
  type InboundMessageRow,
} from './inbound'

const META_IDENTITY = {
  phone: '15550783881',
  waUserId: 'US.13491208655302741918',
  waParentUserId: 'US.ENT.11815799212886844830',
  waUsername: 'customer',
  name: 'Customer Name',
} as const

describe('Meta inbound identity patching', () => {
  it('backfills Meta identity fields and a missing phone number', () => {
    expect(
      contactIdentityPatch(
        {
          id: 'contact-1',
          phone: '',
          name: 'Old Name',
          wa_user_id: null,
          wa_parent_user_id: null,
          wa_username: null,
        },
        META_IDENTITY,
      ),
    ).toEqual({
      name: 'Customer Name',
      wa_user_id: 'US.13491208655302741918',
      wa_parent_user_id: 'US.ENT.11815799212886844830',
      wa_username: 'customer',
      phone: '15550783881',
    })
  })

  it('does not overwrite an existing phone or hand-edited name with fallbacks', () => {
    expect(
      contactIdentityPatch(
        {
          id: 'contact-1',
          phone: '447700900123',
          name: 'Hand-edited name',
          wa_user_id: 'US.13491208655302741918',
        },
        {
          ...META_IDENTITY,
          phone: '15550783881',
          name: '',
          waUsername: null,
        },
      ),
    ).toEqual({
      wa_parent_user_id: 'US.ENT.11815799212886844830',
    })
  })

  it('accepts a phone or BSUID and rejects an identity with neither', () => {
    expect(hasUsableInboundIdentity(META_IDENTITY)).toBe(true)
    expect(
      hasUsableInboundIdentity({
        ...META_IDENTITY,
        phone: '',
      }),
    ).toBe(true)
    expect(
      hasUsableInboundIdentity({
        ...META_IDENTITY,
        phone: '',
        waUserId: null,
      }),
    ).toBe(false)
  })
})

const MESSAGE: InboundMessageRow = {
  conversation_id: 'conversation-1',
  sender_type: 'customer',
  content_type: 'text',
  content_text: 'Hello',
  media_url: null,
  media_type: null,
  message_id: 'wamid.1',
  status: 'delivered',
  created_at: '2026-10-01T00:00:00.000Z',
  reply_to_message_id: null,
  interactive_reply_id: null,
}

function fakeMessageDb(
  data: { id: string }[],
  error: { message: string } | null = null,
) {
  const select = vi.fn(async () => ({ data, error }))
  const upsert = vi.fn(() => ({ select }))
  const from = vi.fn(() => ({ upsert }))

  return {
    db: { from } as unknown as SupabaseClient,
    from,
    upsert,
    select,
  }
}

describe('persistInboundMessage', () => {
  it('uses the conversation/message id idempotency boundary', async () => {
    const fake = fakeMessageDb([{ id: 'message-1' }])

    await expect(persistInboundMessage(fake.db, MESSAGE)).resolves.toEqual({
      inserted: true,
      id: 'message-1',
    })
    expect(fake.from).toHaveBeenCalledWith('messages')
    expect(fake.upsert).toHaveBeenCalledWith(MESSAGE, {
      onConflict: 'conversation_id,message_id',
      ignoreDuplicates: true,
    })
    expect(fake.select).toHaveBeenCalledWith('id')
  })

  it('reports a replay when the conflict insert returns no row', async () => {
    const fake = fakeMessageDb([])

    await expect(persistInboundMessage(fake.db, MESSAGE)).resolves.toEqual({
      inserted: false,
      id: null,
    })
  })

  it('keeps an insert error distinct from an idempotent replay', async () => {
    const fake = fakeMessageDb([], { message: 'database unavailable' })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(persistInboundMessage(fake.db, MESSAGE)).resolves.toBeNull()
    expect(consoleError).toHaveBeenCalled()

    consoleError.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Initial enquiry activation at the shared inbound boundary.
//
// The activation rule itself is tested in `src/lib/enquiries`. What matters
// here is the boundary contract: it runs on the genuine-first-insert path,
// it runs before the bookkeeping downstream consumers depend on, and it can
// never cost us an already-stored inbound message.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

const CONVERSATION = { id: 'conversation-1', account_id: 'account-1' }

function enquiryRow(overrides: Row = {}): Row {
  return {
    id: 'enquiry-seed',
    account_id: 'account-1',
    conversation_id: 'conversation-1',
    created_by_user_id: 'user-1',
    workflow_state: 'new_enquiry',
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
    state_changed_at: '2026-10-01T00:00:00.000Z',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

interface EnquiryBoundaryDb {
  db: SupabaseClient
  enquiries: Row[]
  /** Ordered operation log, so ordering guarantees can be asserted. */
  events: string[]
  failNextEnquiryWrite: (error: Record<string, unknown>) => void
}

function makeBoundaryDb(seedEnquiries: Row[] = []): EnquiryBoundaryDb {
  const enquiries = [...seedEnquiries]
  const events: string[] = []
  let nextId = 1
  let pendingFailure: Record<string, unknown> | null = null

  const db = {
    rpc(name: string) {
      events.push(`rpc:${name}`)
      return Promise.resolve({ data: null, error: null })
    },
    from(table: string) {
      let operation = 'select'
      let payload: Row = {}
      const filters: Array<[string, unknown]> = []
      const orders: Array<[string, boolean]> = []
      let limit: number | null = null

      const rows = (): Row[] => {
        if (table === 'conversations') return [CONVERSATION]
        if (table === 'enquiries') return enquiries
        return []
      }

      const matching = (): Row[] => {
        let result = rows().filter((row) =>
          filters.every(([column, value]) => row[column] === value)
        )
        for (const [column, ascending] of [...orders].reverse()) {
          result = [...result].sort((left, right) => {
            const a = left[column]
            const b = right[column]
            if (a === b) return 0
            const direction = (a as never) < (b as never) ? -1 : 1
            return ascending ? direction : -direction
          })
        }
        return limit === null ? result : result.slice(0, limit)
      }

      const execute = (): { data: unknown; error: unknown } => {
        if (table === 'enquiries') {
          if (pendingFailure) {
            const error = pendingFailure
            pendingFailure = null
            events.push('enquiries:write-failed')
            return { data: null, error }
          }
          if (operation === 'insert') {
            const clash = enquiries.find(
              (row) =>
                row.conversation_id === payload.conversation_id &&
                !['cancelled', 'completed'].includes(
                  String(row.workflow_state),
                )
            )
            if (clash) {
              events.push('enquiries:unique-violation')
              return { data: null, error: { code: '23505', message: 'duplicate' } }
            }
            const row = enquiryRow({ id: `enquiry-${nextId++}`, ...payload })
            enquiries.push(row)
            events.push('enquiries:inserted')
            return { data: row, error: null }
          }
        }
        if (table === 'conversations') events.push('conversations:read')
        return { data: matching()[0] ?? null, error: null }
      }

      const chain = {
        select() {
          return chain
        },
        insert(value: Row) {
          operation = 'insert'
          payload = value
          return chain
        },
        update() {
          return chain
        },
        eq(column: string, value: unknown) {
          filters.push([column, value])
          return chain
        },
        in() {
          return chain
        },
        order(column: string, options?: { ascending?: boolean }) {
          orders.push([column, options?.ascending ?? true])
          return chain
        },
        limit(value: number) {
          limit = value
          return chain
        },
        maybeSingle() {
          return Promise.resolve(execute())
        },
        single() {
          return Promise.resolve(execute())
        },
        then(
          onFulfilled: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) {
          return Promise.resolve(execute()).then(onFulfilled, onRejected)
        },
      }

      return chain
    },
  } as unknown as SupabaseClient

  return {
    db,
    enquiries,
    events,
    failNextEnquiryWrite: (error) => {
      pendingFailure = error
    },
  }
}

function activateInbound(
  fake: EnquiryBoundaryDb,
  overrides: Partial<{
    accountId: string
    configOwnerUserId: string
  }> = {},
) {
  return afterInboundInsert(fake.db, {
    accountId: overrides.accountId ?? 'account-1',
    contactId: 'contact-1',
    conversation: { id: CONVERSATION.id, status: 'open' },
    configOwnerUserId: overrides.configOwnerUserId ?? 'user-1',
    fallbackSummary: 'Hello',
  })
}

describe('afterInboundInsert initial enquiry activation', () => {
  it('activates one enquiry before the conversation bookkeeping runs', async () => {
    const fake = makeBoundaryDb()

    await activateInbound(fake)

    expect(fake.enquiries).toHaveLength(1)
    expect(fake.enquiries[0]).toMatchObject({
      account_id: 'account-1',
      conversation_id: 'conversation-1',
      created_by_user_id: 'user-1',
      workflow_state: 'new_enquiry',
    })
    // Downstream consumers read business state, so activation must not come
    // after the conversation update they observe.
    expect(fake.events.indexOf('enquiries:inserted')).toBeLessThan(
      fake.events.indexOf('rpc:bump_conversation_on_inbound'),
    )
  })

  it('reuses the same enquiry for every later inbound message', async () => {
    const fake = makeBoundaryDb()

    await activateInbound(fake)
    await activateInbound(fake)
    await activateInbound(fake)

    expect(fake.enquiries).toHaveLength(1)
    expect(
      fake.events.filter((event) => event === 'enquiries:inserted'),
    ).toHaveLength(1)
  })

  it('does not create a second enquiry for a conversation with a completed job', async () => {
    const fake = makeBoundaryDb([
      enquiryRow({ id: 'enquiry-done', workflow_state: 'completed' }),
    ])

    await activateInbound(fake)

    expect(fake.enquiries).toHaveLength(1)
    expect(fake.events).not.toContain('enquiries:inserted')
  })

  it('does not create a second enquiry for a conversation with a cancelled job', async () => {
    const fake = makeBoundaryDb([
      enquiryRow({ id: 'enquiry-cancelled', workflow_state: 'cancelled' }),
    ])

    await activateInbound(fake)

    expect(fake.enquiries).toHaveLength(1)
    expect(fake.events).not.toContain('enquiries:inserted')
  })

  it('converges on one enquiry for concurrent first deliveries', async () => {
    const fake = makeBoundaryDb()

    await Promise.all([activateInbound(fake), activateInbound(fake)])

    expect(fake.enquiries).toHaveLength(1)
    expect(fake.events.filter((e) => e === 'enquiries:inserted')).toHaveLength(1)
    expect(fake.events).toContain('enquiries:unique-violation')
  })

  it('keeps the inbound message when enquiry creation fails', async () => {
    const fake = makeBoundaryDb()
    fake.failNextEnquiryWrite({
      code: '23503',
      message:
        'insert or update on table "enquiries" violates foreign key constraint "enquiries_conversation_account_fk"',
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    // The message row is already committed at this point, so activation must
    // not reject: a rejection here would make Meta redeliver and duplicate.
    await expect(activateInbound(fake)).resolves.toBeUndefined()

    // The rest of the boundary still ran.
    expect(fake.events).toContain('rpc:bump_conversation_on_inbound')

    // The failure is surfaced, but as a bounded label — the raw PostgREST
    // message can echo constraint names, SQL, and column values.
    const label = String(consoleError.mock.calls.at(-1)?.[1] ?? '')
    expect(label).toBe('EnquiryRepositoryError:database_error')
    expect(label).not.toContain('violates foreign key constraint')

    consoleError.mockRestore()
  })

  it('retries activation on the next inbound message', async () => {
    const fake = makeBoundaryDb()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    fake.failNextEnquiryWrite({ code: '57014', message: 'canceling statement' })

    await activateInbound(fake)
    expect(fake.enquiries).toHaveLength(0)

    // The rule is "no enquiry history yet", so a later message retries on
    // its own without any separate retry bookkeeping.
    await activateInbound(fake)
    expect(fake.enquiries).toHaveLength(1)
    expect(fake.enquiries[0].workflow_state).toBe('new_enquiry')

    consoleError.mockRestore()
  })

  it('stamps the account owner as the enquiry creator', async () => {
    const fake = makeBoundaryDb()

    await activateInbound(fake, { configOwnerUserId: 'user-42' })

    expect(fake.enquiries[0].created_by_user_id).toBe('user-42')
    expect(fake.enquiries[0].account_id).toBe('account-1')
  })

  it('creates nothing when the conversation is not in that account', async () => {
    const fake = makeBoundaryDb()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    // `conversation-1` belongs to account-1. An account-2 caller must not be
    // able to hang an enquiry off it, and must not crash the webhook.
    await expect(
      activateInbound(fake, { accountId: 'account-2' }),
    ).resolves.toBeUndefined()

    expect(fake.enquiries).toHaveLength(0)
    expect(consoleError).toHaveBeenCalled()

    consoleError.mockRestore()
  })
})
