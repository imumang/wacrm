# WACRM — WhatsApp Business App + Cloud API Coexistence Design

**Status: design only.** No code, migration, or configuration was changed
to produce this document. Every "current behaviour" statement below was
read out of the repository at commit `80c3f9a`; every Meta behaviour
statement cites official Meta documentation retrieved on 2026-09-30.

Governing workflow file: [`AGENTS.md`](../AGENTS.md). Companion
current-state documents (kept accurate and *not* restated here except
where the design depends on them):
[`project-context.md`](./project-context.md),
[`database-architecture.md`](./database-architecture.md),
[`whatsapp-architecture.md`](./whatsapp-architecture.md),
[`development-workflow.md`](./development-workflow.md),
[`testing-checklist.md`](./testing-checklist.md),
[`multi-waba.md`](./multi-waba.md),
[`whatsapp-connection-troubleshooting.md`](./whatsapp-connection-troubleshooting.md).

## Source index for Meta claims

> **URL note (2026-09-30, Phase 0).** Every `…/docs/whatsapp/…` URL in this
> table now returns `404`: Meta moved WhatsApp Business Platform
> documentation to
> `https://developers.facebook.com/documentation/business-messaging/whatsapp/…`.
> §17.1 maps each M-number to its current canonical URL, and §17.4 records
> the content drift found on those pages. Two claims here are now known to
> cite the wrong page and should be re-cited: BISU expiry/refresh
> semantics (cited to M7, actually on M8) and the Embedded Signup
> sandbox-account limitations (cited to M1, which no longer states them in
> §13.7's form).

| # | Page | Retrieved |
| --- | --- | --- |
| M1 | `…/whatsapp/embedded-signup/overview` | 2026-09-30 |
| M2 | `…/whatsapp/embedded-signup/implementation` | 2026-09-30 |
| M3 | `…/whatsapp/embedded-signup/versions` and `/version-4` | 2026-09-30 |
| M4 | `…/whatsapp/embedded-signup/onboarding-business-app-users` | 2026-09-30 |
| M5 | `…/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider` | 2026-09-30 |
| M6 | `…/whatsapp/embedded-signup/onboarding-customers-as-a-solution-partner` | 2026-09-30 |
| M7 | `…/whatsapp/access-tokens` | 2026-09-30 |
| M8 | `…/facebook-login/facebook-login-for-business` | 2026-09-30 |
| M9 | `…/whatsapp/webhooks/overview` | 2026-09-30 |
| M10 | `…/whatsapp/webhooks/reference/smb_message_echoes` | 2026-09-30 |
| M11 | `…/whatsapp/webhooks/reference/account_update` | 2026-09-30 |
| M12 | `…/whatsapp/webhooks/reference/messages/unsupported` | 2026-09-30 |
| M13 | `…/whatsapp/reference/whatsapp-business-phone-number/register-api` | 2026-09-30 |
| M14 | `…/whatsapp/webhooks` embedded on M4 (`history`, `smb_app_state_sync`) | 2026-09-30 |

---

## 1. Current-state summary

### 1.1 Connection model

`whatsapp_config` is one row per account, globally unique on
`phone_number_id`:

| Object | Source | Constraint |
| --- | --- | --- |
| `whatsapp_config` | `supabase/migrations/001` + 013 + 015 + 017 + 039 | `UNIQUE (account_id)` (017), `UNIQUE (phone_number_id)` (013) |
| Columns | 001, 015, 017, 039 | `id`, `user_id`, `account_id`, `phone_number_id`, `waba_id`, `access_token`, `verify_token`, `status`, `connected_at`, `registered_at`, `subscribed_apps_at`, `last_registration_error`, `mirror_inbound_media`, timestamps |

There is **no** column for: Meta app id, business portfolio id, token
type, token expiry, coexistence/opt-in state, `is_on_biz_app`,
`platform_type`, or any onboarding state. Confirmed by reading
`supabase/migrations/001_initial_schema.sql`, `013`, `015`, `039` and by
the table description in `docs/database-architecture.md`.

### 1.2 Onboarding today

There is none in the automated sense. `POST /api/whatsapp/config`
(`src/app/api/whatsapp/config/route.ts`) is a manual credential form. In
order it: resolves `account_id` from `profiles`; validates shape
(`access_token` + `phone_number_id` required, ids digits-only via
`isNumericMetaId`, `pin` must match `/^\d{6}$/`); runs a **service-role**
cross-account `phone_number_id` conflict check returning 409; calls
`verifyPhoneNumber()`; when `waba_id` is present calls
`listWabaPhoneNumbers()` and rejects a mismatched pairing with 400;
encrypts; conditionally calls `registerPhoneNumber()`; calls
`subscribeWabaToApp()` (a failure here aborts the save); then upserts the
row.

`registered_at` is stamped only when a PIN was supplied and
`/register` succeeded. With no PIN the call is skipped
(`registrationSkipped = true`) and `registered_at` stays null — this
exists so Meta TEST numbers, which expose no 2FA PIN, remain connectable
(issue #242).

The token is assumed to be a **Meta System User access token** with
`whatsapp_business_messaging` (required) and
`whatsapp_business_management` (optional in practice; a
`subscribed_apps` failure in the GET health check is reported as a
sub-object, not a failure). There is no exchange, refresh, expiry
check, or scope introspection anywhere in the tree.

### 1.3 Inbound path today

`src/app/api/whatsapp/webhook/route.ts`, `maxDuration = 60`.

- `GET` — requires `hub.mode=subscribe`, `hub.challenge`,
  `hub.verify_token`; loads **every** row of `whatsapp_config` with the
  service role and accepts the handshake if **any** row's decrypted
  `verify_token` matches; opportunistically upgrades a legacy-CBC
  `verify_token` to GCM; else 403.
- `POST` — `await request.text()` for the raw bytes, verify
  `x-hub-signature-256` with `verifyMetaWebhookSignature` (fail-closed
  when `META_APP_SECRET` is unset; accepts a comma-separated secret
  list; `timingSafeEqual`), 400 on malformed JSON, **200 immediately**,
  then `after(async () => processWebhook(body))`.
- `processWebhook()` — per `entry` × `changes`: template fields →
  `handleTemplateWebhookChange` and `continue`; `value.statuses` →
  `handleStatusUpdate`; then the guard
  `if (!value.messages || !value.contacts) continue`.
- Tenant resolution: `whatsapp_config WHERE phone_number_id = ?`;
  0 rows logged and dropped, ≥2 rows logged and dropped, 1 row is the
  config. `decrypt(config.access_token)` once.
- `processMessage()` — `resolveInboundIdentity` (phone or BSUID, BSUID
  from `from_user_id`/`from_parent_user_id`, issue #519); drop if
  neither; `findOrCreateContact` (BSUID index → `findExistingContact`
  last-8 SQL pre-filter + strict JS match → insert, `23505` re-resolve);
  `findOrCreateConversation` (`ORDER BY created_at ASC LIMIT 1`);
  `conversation.created` public webhook; **reaction short-circuit**;
  `parseMessageContent` (which performs the `chat-media` mirror);
  reply-context resolution; the idempotent insert; and only on a
  genuine first insert the fan-out: `bump_conversation_on_inbound` RPC →
  `reopenClosedConversation` → `flagBroadcastReplyIfAny` →
  `dispatchInboundToFlows` → automation triggers → AI auto-reply →
  `message.received` public webhook.
- Idempotency boundary:
  ```ts
  .from('messages').upsert({ …, message_id: message.id, … },
    { onConflict: 'conversation_id,message_id', ignoreDuplicates: true })
    .select('id')
  ```
  backed by `idx_messages_conversation_message_id` (migration 037). An
  empty result means replay and short-circuits everything after it
  (issue #367).

### 1.4 Outbound path today

`sendMessageToConversation()` in `src/lib/whatsapp/send-message.ts`
loads `whatsapp_config` by `account_id` with `.single()`, decrypts,
resolves the target through `recipientFields()` (phone → `to` +
`recipient_type`; BSUID → `recipient`), sends, and persists with
`sender_type: 'agent'`, `status: 'sent'`, `message_id: waMessageId`.

### 1.5 Constants and env

`META_API_VERSION = 'v21.0'` in `src/lib/whatsapp/meta-api.ts`.
Env: `META_APP_SECRET` (comma list), `META_APP_ID` (single, optional —
only used for image-header template Resumable Uploads),
`ENCRYPTION_KEY` (single deployment-wide 64-hex AES-256-GCM key).
Graph version and the coexistence examples in Meta's docs are **not**
aligned — see §15 U7.

### 1.6 Auth and middleware

`src/middleware.ts` 401s `/api/whatsapp/*` except paths containing
`/webhook`. The repo is explicit that middleware is not authorization;
RLS and `requireRole()` are the real gates. `whatsapp_config` is a
settings-class table: `viewer` SELECT, `admin+` INSERT/UPDATE/DELETE
(migration 017).

### 1.7 Explicitly absent (verified by repository-wide search)

No `coexist`, `smb_message_echoes`, `whatsapp_business_app_onboarding`,
`smb_app_data`, `is_on_biz_app`, `history` field handling, Embedded
Signup, OAuth code exchange, `account_update` handling, `edit`/`revoke`
message handling, or history backfill. The only `embedded signup`
occurrence in the tree is an explanatory comment in `meta-api.ts`
(lines ~140–152) about why `/register` is needed.

---

## 2. Meta coexistence requirements

### 2.1 The gating prerequisite

> "You must already be a Solution Partner or Tech Provider."
> — M4, *Requirements*

> "If you are a direct developer, meaning only you or your business will
> be accessing your own data, use a System User access token."
> — M7, *Access Tokens Guide*

This is the single most consequential fact in this document. Embedded
Signup — and therefore coexistence onboarding — is a **partner-only**
surface. An operator who installs WACRM to run their *own* single
business number is a direct developer and has no Embedded Signup path.
WACRM cannot become their Tech Provider.

Consequence for the product: coexistence is an **opt-in capability for
forkers who have partner status**, not a replacement for the current
manual-token path. §16 sequences it accordingly.

### 2.2 Embedded Signup versions and the coexistence feature type

- `whatsapp_business_app_onboarding` is an Embedded Signup **feature
  type**, selected in the `extras` object (v2, v3,
  v2/v3-public-preview) or via `feature_type` in v4 (M3, M4).
- v4 is current (introduced 2025-10-08; `v4-public-preview` 2026-05-12).
  For v4 the `extras` object is **purposely empty** and the version is
  implied by which products are selected in the Facebook Login for
  Business configuration.
- Cloud API requires `whatsapp_business_management` **and**
  `whatsapp_business_messaging`; selecting the Cloud API product in a v4
  login configuration auto-selects those permissions and moves the flow
  to v4 (M3).
- **v2 is deprecated 2026-10-15**; v2, v2/v3-public-preview and v3 are
  all listed "Available Until: October, 2026" (M3). As of this document
  that is roughly two weeks away. See §15 U1.

### 2.3 Technical requirements

| Requirement | Detail | Source |
| --- | --- | --- |
| Business app version | The business must be on WhatsApp Business app **2.24.17+** | M4 |
| Session logging | Embedded Signup **must** be used with session logging (the `message` event listener) | M4 |
| Webhook callback | Must be able to accept and digest webhooks | M4 |
| App field subscriptions | `history`, `smb_app_state_sync`, `smb_message_echoes` **in addition to** whatever the partner already subscribes to | M4 |
| `account_update` | Mandatory for Embedded Signup generally | M2 |
| Partner onboarding limit | 10 new customers / rolling 7 days by default; 200 after Business Verification + App Review + Access Verification | M1 |
| Onboarding TTL | A phone number must be registered within **14 days** of the Embedded Signup flow | M13 |

### 2.4 Token acquisition and lifecycle

Two independent things happen in the browser and both must be relayed
server-side:

1. The **session-logging `message` event** carries the asset ids.
   On coexistence completion `event` is
   `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` and `data` contains the
   customer's WABA id (M4). The generic payload for other finish types
   carries `phone_number_id`, `waba_id`, `business_id` (M2). See
   §15 U6.
2. The **`response_type: 'code'` callback** carries the exchangeable
   token code. Exchangeable **server-side**:
   ```
   GET https://graph.facebook.com/v21.0/oauth/access_token
       ?client_id=<APP_ID>&client_secret=<APP_SECRET>&code=<CODE>
   ```
   → a **business integration system user access token** ("business
   token", BISU) (M5, M6). The code is **single-use** and Meta documents
   a **30-second TTL** (M2).

Business-token lifecycle facts (M7, M8):

| Property | Verified behaviour |
| --- | --- |
| Expiry | "Defaults to **never expire** for the common offline server-to-server communication." The Facebook Login for Business configuration can set a token expiration, and `POST /{client_business_id}/system_user_access_tokens` accepts `set_token_expires_in_60_days=true`. So expiry is **possible but not the default**, and never knowable at exchange time without a `debug_token` call. |
| Rotation | `POST /{client_business_id}/system_user_access_tokens` with `fetch_only` / `asset` / `scope` / `set_token_expires_in_60_days`. **`appsecret_proof` is documented as Required for this endpoint**, and the calling token needs `business_management`. |
| Client-side revocation | The client business can invalidate the token at Business Manager → Settings → Business Settings → Integrations → Connected apps → remove app. Emits `PARTNER_APP_UNINSTALLED` (M11). |
| Client business id | Obtainable via `GET /me?fields=client_business_id` with the business token (M8). |
| Granular tokens | Multiple narrower BISU tokens per client business are supported and recommended for blast-radius isolation (M8). |
| Format | "Treat it as an opaque string… Use a variable-length data type without a specific maximum size" (M7). |

There is **no refresh flow** for a BISU token. The only recovery paths
are: fetch the existing token via the management API, generate a
replacement with the management API, or have the client re-run Embedded
Signup. This is a materially different failure model from the current
long-lived System User token assumption and it is the reason §5.3
mandates token *metadata* even though it stores no secret values.

### 2.5 WABA and phone-number discovery

- WABA → numbers: `GET /{waba_id}/phone_numbers` (already implemented as
  `listWabaPhoneNumbers`).
- Coexistence confirmation (M4):
  ```
  GET https://graph.facebook.com/v25.0/{phone_number_id}
      ?fields=is_on_biz_app,platform_type
  → { "is_on_biz_app": true, "platform_type": "CLOUD_API", "id": "…" }
  ```
- `GET /{waba_id}/subscribed_apps` already implemented as
  `getSubscribedApps`.

### 2.6 Should `/register` still be called?

**No, for coexistence.** M4: "Capture the customer's asset IDs and
exchangeable token code and use them to onboard the customer as you
normally would, but **skip the phone number registration step**, as the
number is already registered."

This directly contradicts M5 Step 3 and M6 Step 4, which both list
`POST /{phone_number_id}/register` as part of the standard onboarding
sequence. Reading M4's "as you normally would" as an explicit override
of the register step is the only coherent interpretation — the number
is on the WhatsApp Business app, not unregistered. This design treats
"skip" as correct and makes the decision an explicit, testable function
of connection mode, so it is cheap to flip if a sandbox spike proves
otherwise (§16 Phase 0). See §15 U3.

Also note M13: `/register` is what enables two-step verification, and
"Setting up two-factor authentication is a requirement to use the Cloud
API." A coexistence number therefore arrives with 2FA already
configured by the business, which is consistent with skipping `/register`
and with the current WACRM UI's "no PIN needed" banner path.

### 2.7 `subscribed_apps` behaviour

`POST /{waba_id}/subscribed_apps` is step 2 of both partner onboarding
paths (M5, M6) and is explicitly called out as a prerequisite for
synchronization in M4 ("make sure that you subscribed the business's
WABA when you onboarded the business, and that you are subscribed to the
additional webhook fields, otherwise you will miss important webhooks").
It is idempotent. WACRM already treats its failure as fatal to the save
(`metaFailure(err, 'subscribe_waba', …)`), which is the right instinct
but is wrong for coexistence for one specific reason: the token must
already be persisted so a subscribe failure is retryable **without
re-running Embedded Signup** (§6.4).

### 2.8 Required webhooks and their payload shapes

All four coexistence fields are **app-level** subscriptions in App
Dashboard → WhatsApp → Configuration, alongside `messages` (M9). They
all arrive at the same callback URL and all carry the same
`object: "whatsapp_business_account"` envelope.

**`smb_message_echoes`** (M4, M10) — a message the business sent from
the WhatsApp Business app or a supported companion device:

```json
{ "object": "whatsapp_business_account",
  "entry": [{ "id": "<WABA_ID>", "changes": [{
    "value": {
      "messaging_product": "whatsapp",
      "metadata": { "display_phone_number": "15550783881",
                    "phone_number_id": "106540352242922" },
      "message_echoes": [{
        "from": "15550783881",            // the BUSINESS number
        "to":   "16505551234",            // the WhatsApp USER
        "id":   "wamid.HBgL…",
        "timestamp": "1739321024",
        "type": "text",
        "text": { "body": "…" } }]
    },
    "field": "smb_message_echoes" }]}]}
```

Documented properties that drive design:

- **No `contacts[]` array.** The customer is identified only by `to`,
  and `to` is phone-only — there is no BSUID. See §8.1.
- Documented `type` values include `text`, `image`, `video`, `document`,
  `revoke`, and `edit`.
- `revoke` carries `revoke.original_message_id`; `edit` carries
  `edit.original_message_id` plus an embedded `edit.message` object
  (which itself has a `context.id`).
- Media contents follow the send-messages shapes. The `edit` example's
  media object includes both `id` and a direct `url`
  (`lookaside.fbsbx.com/...`); the plain text example has no media.
  See §15 U4.
- The reference table types `<WHATSAPP_USER_PHONE_NUMBER>` as
  `+16505551234` while the example shows `16505551234` — see §15 U8.

**`history`** (M4, M14) — chat-history backfill, **only** if the
business consented at the "Confirm" step inside the WhatsApp Business
app:

```json
{ "value": {
    "messaging_product": "whatsapp",
    "metadata": { "display_phone_number": "…", "phone_number_id": "…" },
    "history": [{
      "metadata": { "phase": 0, "chunk_order": 1, "progress": 55 },
      "threads": [{
        "id": "16505551234",                     // the WhatsApp USER
        "messages": [{
          "from": "15550783881",                 // business OR user
          "to":   "16505551234",                 // only if SMB message echo
          "id": "wamid.…", "timestamp": "1739230955",
          "type": "text", "text": { "body": "…" },
          "history_context": { "status": "READ" } }]}]}]},
  "field": "history" }
```

- Contents: messages sent or received within **180 days** of onboarding.
- Group chats excluded. Disappearing messages, view-once and live
  location are **disabled** for 1:1 chats post-onboarding.
- Three phases: `0` = day 0–1, `1` = day 1–90, `2` = day 90–180.
  Chunks within a phase may arrive **out of order** (`chunk_order`).
  `progress: 100` means complete. **No webhooks at all** for a phase
  with no history.
- **A single webhook can describe thousands of messages** — M4 says
  explicitly to "capture its contents first, then process the contents
  asynchronously". M9 caps payloads at 3 MB.
- Media: a media message first arrives as `type: "media_placeholder"`
  with contents omitted; a **separate history webhook** supplies the
  media asset id — but **only** for media sent within **14 days** of the
  query.
- `history_context.status` values: `DELIVERED`, `ERROR`, `PENDING`,
  `PLAYED`, `READ`, `SENT`.
- **Declined sharing** produces a `history[]` entry with **no**
  `metadata` and `errors[0].code === 2593109`.
- **24-hour window**: "After you onboard the business customer, you have
  24 hours to synchronize their contacts and messaging history,
  otherwise they must be offboarded and they must complete the flow
  again." Both the contacts step and the history step can be performed
  **only once**; a repeat requires offboarding and a new Embedded Signup
  run. See §15 U9.

**`smb_app_state_sync`** (M4, M14) — contacts:

```json
{ "value": {
    "messaging_product": "whatsapp",
    "metadata": { … },
    "state_sync": [{
      "type": "contact",
      "contact": { "full_name": "…", "first_name": "…",
                   "phone_number": "16505551234" },
      "action": "add",            // or "remove"
      "metadata": { "timestamp": "1738346006" } }]},
  "field": "smb_app_state_sync" }
```

- Triggered by the initial contacts sync **and** by every subsequent
  add/edit/remove in the business's phone address book.
- `full_name` / `first_name` are omitted on `remove`.

**`account_update`** (M4, M11) — the coexistence-relevant events:

| `event` | `disconnection_info` | Meaning for WACRM |
| --- | --- | --- |
| `PARTNER_REMOVED` | present only when the business was using **both** the app and Cloud API | coexistence ended. `reason` ∈ `ACCOUNT_DISCONNECTED`, `BUSINESS_DOWNGRADE`, `CHANGE_NUMBER`, `COMPANION_INACTIVITY`, `PRIMARY_INACTIVITY`, `USER_RE_REGISTERED`; `initiated_by` ∈ `USER`, `SYSTEM` |
| `PARTNER_APP_UNINSTALLED` | — | the business revoked the app → **every stored token is dead** |
| `PARTNER_APP_INSTALLED` | — | informational |
| `PARTNER_ADDED` | — | informational |
| `ACCOUNT_OFFBOARDED` | — | offboarded due to device change / number re-registration |
| `ACCOUNT_RECONNECTED` | — | reconnected after offboarding |
| `ACCOUNT_DELETED`, `ACCOUNT_RESTRICTION`, `ACCOUNT_VIOLATION`, `DISABLED_UPDATE` | — | WABA unusable |

`entry.id` is the **WABA id** for `account_update` — the same
tenant-resolution shape `template-webhook.ts` already handles (issue
#534).

### 2.9 History and contacts synchronization API

```
POST /{phone_number_id}/smb_app_data
Authorization: Bearer <BUSINESS_TOKEN>
Content-Type: application/json
{ "messaging_product": "whatsapp", "sync_type": "smb_app_state_sync" }
→ { "messaging_product": "whatsapp", "request_id": "<REQUEST_ID>" }
```
and the same call with `"sync_type": "history"`. Store `request_id` for
Meta support. M4 states both are one-shot.

### 2.10 Statuses for mobile-originated messages

There is **no documented status webhook for `smb_message_echoes`**. M9
describes the `messages` field as covering "the status of messages sent
by a business to a WhatsApp user" in the API-send sense; the only
per-message delivery state documented for app-originated messages is
`history_context.status` inside the `history` field, which is a
backfill artifact, not a live feed.

Reading: WACRM will receive an echo when the business sends from the
app, and will receive **no** `sent`/`delivered`/`read` progression for
it. §15 U5 records this as a documented gap rather than a known Meta
behaviour, and §7.4 designs for it.

### 2.11 Coexistence limitations that affect WACRM

| Limitation (M4, M1) | WACRM impact |
| --- | --- |
| Fixed **20 mps** throughput for coexistence numbers | `broadcast-core.ts` has no throughput backoff; the only retry is the `phoneVariants` loop on `isRecipientNotAllowedError`. See §15 U14. |
| Messages from the app are **free** and do not create, extend or affect Cloud API conversation windows or Cloud API pricing | WACRM's "24-hour customer service window" reasoning (documented in `send-message.ts`) is unaffected for API sends, but a business could send from the app and WACRM will not know a window was opened. |
| Customer service window opens only when a user messages an **already-onboarded** business | First-contact-after-onboarding behaves specially — see §2.12. |
| Group chats, calls, broadcast lists, catalog/orders/status, quick replies, labels, business profile, channels — **not supported** on Cloud API and not synchronized | Out of scope. WACRM has no group-chat concept today, so no regression. |
| Disappearing messages, view-once and live location **disabled** for 1:1 chats post-onboarding | Product-visible side effect for the business; the UI should say so before the business commits. |
| Companion clients: up to four, all unlinked at onboarding; **WhatsApp for Windows and WearOS are not supported companions**. Messages from an unsupported companion **do not trigger `messages` webhooks at all**, and app-sent messages viewed there show placeholder text. | Silent inbound loss. WACRM should surface a warning during onboarding. |
| Deregister API **cannot** deregister a coexistence number. Offboarding is done by the business in the app (Settings → Account → Business Platform → Disconnect Account), which emits `PARTNER_REMOVED` + `disconnection_info`. | WACRM's `DELETE /api/whatsapp/config` ("Reset Configuration") must **not** imply a Meta-side deregistration for a coexistence row. UI wording change. |
| Existing WABAs originally created via the developer app cannot be selected in Embedded Signup (M1) | Constrains which numbers are eligible. |
| Business phone numbers can only be registered for use with Cloud API (M1) | A number cannot be simultaneously an app-only number and a Cloud API number outside coexistence. |

### 2.12 New inbound message types WACRM does not handle today

These arrive on the **`messages`** field, not the coexistence fields,
so they hit the existing pipeline:

1. **`type: "unsupported"`** with `errors[0].code === 131060` — "This
   message is currently unavailable", which M4 and M12 both document as
   **expected** on first contact with a coexistence number and on
   messages from an unsupported companion device. M4: "instruct the
   business to check the WhatsApp Business app for the message." Today
   `parseMessageContent` would store the literal text
   `[Unsupported message type: unsupported]` as a customer text bubble.
2. **`type: "edit"`** with `edit.original_message_id` + `edit.message` —
   customer edits a sent message (M4, M12).
3. **`type: "revoke"`** with `revoke.original_message_id` — customer
   deletes a sent message (M4, M12).
4. `unsupported.type` may also be `media_placeholder`, `order`, `poll_*`,
   `group_invite`, `keep_in_chat`, `link_preview`, `pin`, `product`,
   `hsm`, `button`, `list`, `errors`, `reaction`, `gif`, `image`,
   `interactive`, `location` (M12).
5. `contacts[].identity_key_hash` (M12) — only when the identity-change
   check is enabled. Optional; not required by coexistence.

---

## 3. Proposed target architecture

### 3.1 Two supported modes, one table

`connection_mode` on `whatsapp_config`:

| Mode | Token | Onboarding | Inbound | Statuses | Echoes / history / state sync |
| --- | --- | --- | --- | --- | --- |
| `api_only` (existing) | System User (long-lived) | manual form in `POST /api/whatsapp/config` | `messages` | `messages.statuses` | must not arrive; ignored if they do |
| `coexistence` (new) | Business Integration System User, from code exchange | Embedded Signup with `feature_type: whatsapp_business_app_onboarding` | `messages` | `messages.statuses` (API sends only) | `smb_message_echoes`, `history`, `smb_app_state_sync` |

**Recommendation: keep both modes permanently.** Reasons:

1. Embedded Signup is partner-only (§2.1). Removing the manual path
   would break the template's core self-hosting promise for every
   operator without partner status.
2. `docs/multi-waba.md` Setups A and B are manual-token setups and stay
   valid.
3. The two modes have genuinely different token lifecycles (§2.4) and
   different registration rules (§2.6), so a mode discriminator is
   required for correctness even if coexistence were the only path.
4. The mode is additive: `api_only` rows keep their current behaviour
   byte-for-byte.

Coexistence is gated behind a deployment env flag, default off, so no
existing deployment changes behaviour from upgrading.

### 3.2 Architectural boundaries

```
Browser (client component, settings panel)
  │  1. POST /api/whatsapp/onboarding/session   → { session_id, nonce }   (once)
  │  2. load connect.facebook.net SDK, FB.init({ appId, version })
  │  3. FB.login(cb, { config_id, response_type:'code',
  │                   override_default_response_type:true,
  │                   extras: { featureType:'whatsapp_business_app_onboarding' } })
  │  4. on code + session event → POST /api/whatsapp/onboarding/complete
  │        { session_id, nonce, code, session_event }
  ▼
Server (admin+ only, no Meta call ever leaves the browser)
  • validate session (account-bound, single-use, TTL, Origin/Host)
  • GET /oauth/access_token  (code → BISU token)         ← inline, code TTL 30s
  • cross-account phone_number_id uniqueness check (service role)
  • persist token + metadata + onboarding state   ◄── persist BEFORE subscribing
  • POST /{waba_id}/subscribed_apps                     ◄── retryable
  • GET /{phone_number_id}?fields=is_on_biz_app,platform_type
  ▼
Meta webhooks → GET/POST /api/whatsapp/webhook
  • existing HMAC path unchanged
  • per-field dispatch: messages | statuses | template_* | account_update
                        | smb_message_echoes | history | smb_app_state_sync
  • messages  → existing pipeline (unchanged for api_only)
  • echoes/history/state_sync/account_update → coexistence handlers
```

Invariants:

- **No Meta credential ever crosses the browser.** The client sends a
  30-second code and nothing else. Everything else is server-derived.
- **No Meta call from the browser.** M5/M6: "Perform all of the requests
  described below using server-to-server requests. Do not use
  client-side requests."
- **The token is persisted before the first fallible Meta call**, so a
  failure never forces a re-run of Embedded Signup.
- **Fail-closed everywhere.** Unknown webhook field → logged, dropped,
  200 (never a 4xx, which would make Meta retry for up to 7 days —
  M9). Unknown Meta error → generic operator-facing text, structured
  `code`/`subcode`/`fbtrace_id` for support, never a raw Meta body.

### 3.3 What is deliberately **not** changed

| Phase 1 constraint | Decision |
| --- | --- |
| One account per `whatsapp_config` | **Kept.** `UNIQUE (account_id)` is not relaxed. Coexistence needs no second number per account, and keeping it means the webhook's `phone_number_id` → single-account routing stays sound. |
| Global unique `phone_number_id` | **Kept**, and promoted from an app-level 409 to a hard DB constraint that the coexistence path also checks. This is the WABA-hijack control. |
| Manual-credentials onboarding | **Kept** as the `api_only` path. The coexistence form is additive; the manual form must refuse to overwrite a coexistence row without an explicit disconnect. |
| `/register` on manual save | **Kept** exactly as-is for `api_only`. |
| Webhook requires `messages` **and** `contacts` | **Kept for the `messages` branch.** New coexistence fields get their own branches **before** that guard. |
| Idempotency on `(conversation_id, message_id)` | **Kept and reused.** Echo and history wamids land in the same index, so no new uniqueness mechanism is introduced. |
| Long-lived System User token assumption | **Kept for `api_only`.** For `coexistence` the assumption is replaced by explicit token *metadata* plus a state machine — the token value itself is still stored in the same single encrypted column. |
| `whatsapp_config` one encrypted `access_token` column | **Kept.** A second token column would fork `decrypt(config.access_token)` across six-plus call sites for no benefit. |
| Graph API `v21.0` module constant | **Kept as the default.** Coexistence-only endpoints get a per-call version override; a global version bump is a separate task. |
| `src/middleware.ts` (not `proxy.ts`) | **Untouched.** |

---

## 4. Onboarding sequence

### 4.1 Coexistence (new path)

**Preconditions (server-checked, fail-closed, 503 with actionable text):**

| Precondition | Check | Failure message |
| --- | --- | --- |
| Deployment flag on | `META_EMBEDDED_SIGNUP_ENABLED === 'true'` | feature not enabled on this deployment |
| App id known | `META_APP_ID` set and digits | Embedded Signup needs the Meta App ID |
| Login configuration id known | `META_EMBEDDED_SIGNUP_CONFIG_ID` set and digits | create a Facebook Login for Business configuration |
| App secret known | resolvable for `META_APP_ID` | the code exchange needs this app's secret |
| App secret present | `META_APP_SECRET` parses to ≥1 secret | fail-closed, matching `webhook-signature.ts` |
| Caller is admin+ | `requireRole('admin')` | 403 |
| Account has no coexistence row | no `connection_mode = 'coexistence'` | disconnect first |

**Steps:**

1. **Mint a session nonce.**
   `POST /api/whatsapp/onboarding/session` → insert
   `whatsapp_onboarding_sessions` with `nonce_hash = sha256(nonce)`,
   `expires_at = now() + 5 min`, bound to `account_id` + `user_id` +
   observed `Origin`. Return `{ session_id, nonce }`. The plaintext
   nonce is returned once and never persisted. Rate-limited per user and
   per client IP.

2. **Launch Embedded Signup (browser).** `next/script` loads
   `https://connect.facebook.net/en_US/sdk.js` on demand.
   `FB.init({ appId, xfbml: true, version })` with the app id and graph
   version fetched from the server (not from `NEXT_PUBLIC_*`, which is
   inlined at build time and would not work for a self-hosted fork with a
   different app). `FB.login(cb, { config_id, response_type: 'code',
   override_default_response_type: true, extras })`.
   `extras` is **server-supplied**: `{ featureType:
   'whatsapp_business_app_onboarding' }` for v2/v3, `{}` for v4. The
   version is an operator setting, not a hardcoded constant, because v4
   and v3 have different `extras` shapes and v2 dies 2026-10-15.

3. **Capture both browser signals.** The `message` event listener
   (origin must end in `facebook.com`) and the `FB.login` response
   callback. Both are posted together to `complete`.

4. **Complete (server).** `POST /api/whatsapp/onboarding/complete`:
   1. `requireRole('admin')`; resolve `account_id`.
   2. Load the session; require `account_id` match, `consumed_at IS
      NULL`, `expires_at > now()`; verify `sha256(nonce)` with
      `timingSafeEqual`.
   3. Verify `Origin` and `Host` against an allowlist.
   4. Mark the session consumed **before** the exchange, so a
      double-submit cannot exchange twice.
   5. **Inline** `GET /oauth/access_token`. 30-second TTL: no queue, no
      retry, no persistence of the code. On failure → state
      `code_expired`, UI: "run onboarding again".
   6. Derive identity from Meta, not from the client:
      `GET /{waba_id}/phone_numbers?fields=id,display_phone_number,
      verified_name,is_on_biz_app,platform_type` and
      `GET /me?fields=client_business_id`. Cross-check against the
      browser-reported `session_event` asset ids and **log a mismatch**;
      never prefer the client.
   7. **Cross-account uniqueness check** on the derived
      `phone_number_id` (service role, `.eq().neq('account_id')`) →
      409 on conflict, matching the existing behaviour and reason text.
   8. **Persist first:** `connection_mode='coexistence'`,
      `token_type='business_integration_system_user'`,
      `access_token = encrypt(token)`,
      `token_app_id = META_APP_ID`, `token_client_business_id`,
      `token_obtained_at = now()`, `token_expires_at = null`,
      `token_scopes` (if a `debug_token` probe is run),
      `phone_number_id`, `waba_id`, `business_id`,
      `onboarding_state='token_exchanged'`,
      `registration_mode='skipped_coexistence'`,
      `is_on_biz_app`, `platform_type`, `registered_at = now()`
      (registration is satisfied, not attempted).
   9. `POST /{waba_id}/subscribed_apps` (idempotent). Success →
      `subscribed_apps_at = now()`, `onboarding_state='waba_subscribed'`,
      `status='connected'`, `connected_at = now()`. Failure → keep the
      persisted token, `onboarding_state='failed'`,
      `onboarding_error_step='subscribe_waba'`, return 200 with a
      retry affordance. **No re-run of Embedded Signup is required.**
   10. Return `{ ok, phone_info, coexistence, next_actions }`.

5. **Sync contacts (server, once).**
   `POST /api/whatsapp/onboarding/sync { sync_type:'smb_app_state_sync' }`
   → `POST /{phone_number_id}/smb_app_data` → store `request_id` +
   `contacts_sync_requested_at`. **Refuse locally if already
   requested** — M4 says a second call is not retryable, so a double
   click must not burn it.
   - To minimise `maxDuration` risk the two sync calls are issued
     **concurrently**; they are independent and both are one-shot.

6. **Sync history (server, once).** Same endpoint with
   `sync_type:'history'`. Record `history_sync_requested_at` and
   `history_sync_deadline_at = onboarding_completed_at + 24h`. The UI
   shows a live countdown.
   - A `history[]` entry with `errors[0].code === 2593109` sets
     `onboarding_state='history_sync_declined'` — **not** an error.
   - `progress: 100` sets `history_sync_complete`.

7. **Steady state.** `smb_message_echoes` and `smb_app_state_sync` are
   driven by Meta; `messages` continues as before.

### 4.2 `api_only` (unchanged)

`POST /api/whatsapp/config` behaves exactly as it does today, with one
added guard: if the account's row is `connection_mode='coexistence'`,
return 409 with "disconnect the WhatsApp Business app connection first"
rather than overwriting it. No other branch changes.

### 4.3 Onboarding a number already active in the WhatsApp Business app

That **is** the coexistence flow. There is no separate path. The
business must:

- be on WhatsApp Business app ≥ 2.24.17 (M4);
- accept the verification code WhatsApp sends from the official
  Facebook Business Account, tap **Connect → Connect to the Business
  Platform → Confirm** (M4) — the Confirm step is where chat-history
  sharing is granted or declined;
- complete the remaining Embedded Signup screens.

WACRM's role is to launch the flow, exchange the code, subscribe, sync,
and then show live state. If the business declines history, WACRM says
so and moves on.

### 4.4 Migrating an existing WACRM Cloud API-only number to coexistence

**This is not supported, and Meta does not document a way to do it.**

Reasoning: the coexistence flow requires the number to be *currently in
use with the WhatsApp Business app* (M1: "Business phone numbers already
in use with the WhatsApp Business app are supported, but require you
customize the flow"). A number already registered on Cloud API is not on
the app. M1 also states plainly: "Business phone numbers can only be
registered for use with Cloud API." There is no documented deregistration
-then-coexist path, and the Deregister API is explicitly **blocked** in
the coexistence state (M4) — the only offboarding route is the business
disconnecting from inside the app.

Practical options for an operator who wants coexistence for a number
WACRM already runs on Cloud API:

| Option | Consequence |
| --- | --- |
| **A. Do nothing.** Keep the number `api_only`. | The business cannot use the WhatsApp Business app on it. This is the only zero-risk answer. |
| **B. Migrate the number to the WhatsApp Business app first, off-app, then onboard via coexistence.** | Destructive and entirely outside WACRM: the business must deregister from Cloud API and register on the app, which changes the number's identity, resets its 2FA PIN, and likely resets its quality rating / messaging tier. Any history WACRM already holds is not backfilled by the 180-day sync of a *different* account state. WACRM should refuse to be the tool that does this and should say so. |
| **C. Onboard a second, different number via coexistence.** | Requires a second WACRM account, because `UNIQUE (account_id)` is one-number-per-account. |

**Recommendation:** ship A as the documented answer, and in the UI say
explicitly that coexistence applies to numbers *not yet on Cloud API*.
Do not build a "convert my number" affordance. See §15 U11.

---

## 5. Database / schema design

All changes are **additive**. No column is dropped, renamed, retyped, or
tightened. No existing CHECK is widened. The two constraints
`UNIQUE (account_id)` and `UNIQUE (phone_number_id)` are untouched.
Follow the repo's convention: nullable → backfill → `SET NOT NULL`, each
statement `IF NOT EXISTS`-guarded, with `COMMENT ON COLUMN` (the 039/042
convention) and a matching assertion in `supabase/ci/verify-schema.sql`.

### 5.1 Migration 043 — `whatsapp_config` columns

```sql
-- Mode + coexistence facts -------------------------------------------
connection_mode        TEXT NOT NULL DEFAULT 'api_only'
  CHECK (connection_mode IN ('api_only','coexistence'));

coexistence_enabled_at TIMESTAMPTZ;
coexistence_enabled_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
is_on_biz_app          BOOLEAN;   -- last observed from Meta
platform_type          TEXT;      -- last observed from Meta (CLOUD_API, …)
coexistence_verified_at TIMESTAMPTZ;  -- last successful coexistence probe

-- Onboarding state machine -------------------------------------------
onboarding_state       TEXT NOT NULL DEFAULT 'idle'
  CHECK (onboarding_state IN (
    'idle',               -- nothing attempted (every pre-043 row lands here)
    'session_created',    -- nonce minted, popup pending
    'code_received',      -- client posted a code, exchange not yet confirmed
    'token_exchanged',    -- BISU token stored
    'waba_subscribed',    -- POST /subscribed_apps succeeded
    'ready',              -- usable; sync state is tracked separately
    'sync_started',       -- one or both sync calls accepted
    'sync_complete',      -- progress 100 on history AND contacts received
    'sync_declined',      -- business declined chat-history sharing (2593109)
    'sync_expired',       -- 24h window elapsed; offboard + re-run required
    'failed',             -- onboarding_error + onboarding_error_step say why
    'offboarded'          -- PARTNER_REMOVED / ACCOUNT_OFFBOARDED seen
  ));
onboarding_error       TEXT;
onboarding_error_step  TEXT;   -- reuses the MetaConnectStep vocabulary
onboarding_updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Token metadata. NO secret values in any of these. ------------------
token_type             TEXT NOT NULL DEFAULT 'system_user'
  CHECK (token_type IN ('system_user','business_integration_system_user'));
token_app_id           TEXT;      -- always META_APP_ID for coexistence rows
token_client_business_id TEXT;    -- GET /me?fields=client_business_id
token_obtained_at      TIMESTAMPTZ;
token_expires_at       TIMESTAMPTZ;  -- NULL = non-expiring (Meta's default)
token_last_verified_at TIMESTAMPTZ;  -- last successful /debug_token probe
token_scopes           TEXT[];    -- informational, from /debug_token
token_revoked_at       TIMESTAMPTZ;  -- set on PARTNER_APP_UNINSTALLED

-- Registration bookkeeping -------------------------------------------
-- Disambiguates the three ways registered_at can be reached today and
-- stops the UI showing a red "Not registered" banner for a coexistence
-- number that is, by definition, already registered.
registration_mode     TEXT NOT NULL DEFAULT 'pin'
  CHECK (registration_mode IN
    ('pin','skipped_test_number','skipped_coexistence'));
registration_skipped_reason TEXT;

-- Sync progress (one-shot operations; progress is Meta-driven) --------
contacts_sync_request_id   TEXT;
contacts_sync_requested_at TIMESTAMPTZ;
contacts_sync_completed_at TIMESTAMPTZ;
history_sync_request_id    TEXT;
history_sync_requested_at  TIMESTAMPTZ;
history_sync_phase         SMALLINT  CHECK (history_sync_phase BETWEEN 0 AND 2);
history_sync_chunk_order   INTEGER;
history_sync_progress      SMALLINT  CHECK (history_sync_progress BETWEEN 0 AND 100);
history_sync_completed_at  TIMESTAMPTZ;
history_sync_deadline_at   TIMESTAMPTZ;  -- requested_at + 24h
disconnection_reason       TEXT;   -- from account_update disconnection_info
disconnection_initiated_by TEXT;   -- USER | SYSTEM
```

Backfill: every column above is `NULL` or takes its `DEFAULT` for
existing rows. `connection_mode='api_only'` and `token_type='system_user'`
are therefore **correct for every pre-existing row** — no row is
misclassified and no behaviour changes. `registration_mode` backfills to
`'pin'` when `registered_at IS NOT NULL` and `'skipped_test_number'`
otherwise, which is exactly what the current `registrationSkipped` logic
already distinguishes.

### 5.2 Migration 044 — new table `whatsapp_onboarding_sessions`

```sql
CREATE TABLE IF NOT EXISTS whatsapp_onboarding_sessions (
  id           UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  nonce_hash   TEXT NOT NULL,             -- sha256(nonce); plaintext never stored
  origin       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  finish_event TEXT,                      -- FINISH | FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING | …
  outcome      TEXT,                      -- completed | code_expired | subscribe_failed | …
  UNIQUE (nonce_hash)
);
ALTER TABLE whatsapp_onboarding_sessions ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policies: the service role is the only reader/writer.
-- A client never reads this table; the nonce is returned once in the
-- mint response and only its hash is persisted.
CREATE INDEX IF NOT EXISTS idx_wacrm_onboarding_sessions_pending
  ON whatsapp_onboarding_sessions (expires_at)
  WHERE consumed_at IS NULL;
```

This mirrors `account_invitations`' "store only the hash" convention
(migration 017, `token_hash`), and `peek_invitation` /
`redeem_invitation` are the precedent for the single-use consume
transaction. Use an RPC (`redeem_whatsapp_onboarding_session`) that
does `UPDATE … SET consumed_at = now() WHERE id = ? AND consumed_at IS
NULL AND expires_at > now() AND account_id = ? RETURNING id` — that
makes consumption atomic and race-free, exactly as migration 019 does for
invitations. `REVOKE` from `PUBLIC`, `anon`, `authenticated`; `GRANT` to
`service_role` only.

### 5.3 Migration 045 — new table `whatsapp_webhook_queue`

Required because M4 says a single `history` webhook "could potentially
describe thousands of messages" and M9 caps payloads at 3 MB, while
WACRM's webhook route has `maxDuration = 60` and does all work inside one
`after()` invocation.

```sql
CREATE TABLE IF NOT EXISTS whatsapp_webhook_queue (
  id              BIGSERIAL PRIMARY KEY,
  account_id      UUID REFERENCES accounts(id) ON DELETE CASCADE,
  phone_number_id TEXT,
  waba_id         TEXT,
  field           TEXT NOT NULL
    CHECK (field IN ('history','smb_message_echoes',
                     'smb_app_state_sync','account_update')),
  payload         JSONB NOT NULL,
  payload_digest  TEXT NOT NULL,     -- sha256 of the canonicalised change
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ,
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  UNIQUE (field, payload_digest)
);
ALTER TABLE whatsapp_webhook_queue ENABLE ROW LEVEL SECURITY;  -- no policies
CREATE INDEX IF NOT EXISTS idx_wacrm_waba_queue_unprocessed
  ON whatsapp_webhook_queue (received_at)
  WHERE processed_at IS NULL;
```

`UNIQUE (field, payload_digest)` makes ingestion itself idempotent, which
matters because M9 says Meta retries any non-200 for **up to 7 days** —
a `history` chunk can be redelivered long after `progress: 100`.

Only coexistence-relevant fields are queued. The existing `messages`,
`statuses` and `message_template_*` paths stay inline exactly as today.

### 5.4 Migration 046 — `messages` additive columns

```sql
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS source     TEXT,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- source: NULL on every existing row (equivalent to 'api').
--   'api'         message sent or received through the Cloud API
--   'business_app' outbound echo from the WhatsApp Business app / companion
--   'history_sync' backfilled from the `history` webhook
-- Deliberately NOT a new sender_type: messages.sender_type is a CHECK on
-- ('customer','agent','bot') and widening it would ripple through the
-- inbox renderer, the public API and every sender_type filter. An echo is
-- genuinely an 'agent' (business-side) message with a different origin.
--
-- deleted_at: set by the `revoke` handler. Revoke is documented on both
-- the `messages` field (customer-side) and `smb_message_echoes`
-- (business-side). Hard-deleting a row would destroy broadcast
-- reconciliation and reply-quote chains, so revoke is a soft delete and
-- the inbox query filters on it.
```

`source` is nullable so no `messages` backfill is needed and no index is
required unless a filter is added later (if one is, add a partial index
`WHERE source IS NOT NULL`).

### 5.5 What is *not* in the schema

- No second `access_token` column. One encrypted column, two token
  types, discriminated by `token_type`.
- No `appsecret_proof` column. It is derived per request from
  `META_APP_ID` + the resolved app secret and never persisted.
- No plaintext `code`, `nonce`, PIN, or `request_id`-to-token mapping.
- No `whatsapp_config` re-keying, re-encryption, or key rotation. The
  existing GCM/CBC handling and the idempotent legacy upgrade are
  untouched.

### 5.6 RLS

| Table | Policy |
| --- | --- |
| `whatsapp_config` | unchanged — `viewer` SELECT, `admin+` write (017) |
| `whatsapp_onboarding_sessions` | RLS on, **zero policies** — service role only |
| `whatsapp_webhook_queue` | RLS on, **zero policies** — service role only |
| `messages` | unchanged; new columns inherit the existing conversation-membership SELECT policy |

Rationale for zero policies: both new tables are pure server-side
machinery. A client never reads them, so an RLS policy is a liability,
not a feature. This is the same reasoning as the `service_role`-only
grants on `bump_conversation_on_inbound` and
`create_broadcast_with_recipients` (migrations 037/041). Any
human-readable onboarding log the UI needs should be served by a route
that selects explicit columns, never by reading these tables directly
from the client.

---

## 6. API / backend changes

### 6.1 New routes

All under `/api/whatsapp/onboarding/`, all `requireRole('admin')`
explicitly, all rate-limited with `checkRateLimit`. The middleware's
`/api/whatsapp/*` 401 already covers them, but middleware is not
authorization and is not relied on.

| Route | Method | Body | Returns |
| --- | --- | --- | --- |
| `/api/whatsapp/onboarding/session` | POST | — | `{ session_id, nonce, expires_at, app_id, graph_version, config_id, extras, enabled, disabled_reason? }` |
| `/api/whatsapp/onboarding/complete` | POST | `{ session_id, nonce, code, session_event }` | `{ ok, phone_info, coexistence:{ is_on_biz_app, platform_type }, state, error?, meta? }` |
| `/api/whatsapp/onboarding/state` | GET | — | `{ connection_mode, onboarding_state, onboarding_error*, coexistence, sync:{ contacts, history }, token:{ type, app_id, obtained_at, expires_at, last_verified_at, scopes } }` — **no token value, ever** |
| `/api/whatsapp/onboarding/sync` | POST | `{ sync_type: 'smb_app_state_sync' \| 'history' }` | `{ ok, request_id, requested_at, deadline_at }` or `{ ok:false, error, already_requested:true }` |
| `/api/whatsapp/onboarding/retry-subscribe` | POST | — | `{ ok }` — re-runs `subscribed_apps` with the stored token |
| `/api/whatsapp/history/drain` | POST | — | cron-pinged, `x-cron-secret`, drains `whatsapp_webhook_queue` in bounded batches |

Explicitly **rejected** from the `complete` body: `phone_number_id`,
`waba_id`, `business_id`, `access_token`, `app_id`, `client_secret`.
Rejecting unknown keys outright is better than ignoring them — a body
that carries a token is a bug or an attack.

`GET /api/whatsapp/onboarding/state` replaces the idea of a separate
`/coexistence/status` route: fewer endpoints, one source of truth.

### 6.2 `POST /api/whatsapp/config` (changed, minimally)

One new guard, before any Meta call:

```ts
if (existing?.connection_mode === 'coexistence') {
  return NextResponse.json({
    error: 'This account is connected through the WhatsApp Business app (coexistence). '
         + 'Disconnect that connection before saving manual credentials.',
    field: 'connection_mode',
  }, { status: 409 })
}
```

Plus: stamp `registration_mode` (`'pin'` / `'skipped_test_number'`) and
`token_type='system_user'` on save so the two new discriminators are
always populated. **Every other branch, ordering, status code and
response shape is unchanged**, including the deliberate non-fatal
`/register` failure and the fatal `subscribed_apps` failure.

### 6.3 `GET /api/whatsapp/config` (changed, additively)

Keep the shape-200 contract and the existing `reason` values verbatim
(`no_account`, `no_config`, `db_error`, `token_corrupted`,
`meta_api_error`). Add two response fields:

- `connection_mode`
- `coexistence: { enabled, is_on_biz_app, platform_type, state, sync }`

For a coexistence row, extend `verifyPhoneNumber`'s field list to
`id,display_phone_number,verified_name,quality_rating,is_on_biz_app,platform_type`
so a health check surfaces coexistence drift. This is a new field on an
existing read, not a new call.

### 6.4 Ordering inside `complete` — persist before you subscribe

This is the one ordering that genuinely matters and it is the inverse of
`POST /api/whatsapp/config` (where `subscribed_apps` correctly aborts
before persisting, because nothing is at stake yet).

Reason: the exchangeable code is single-use with a 30-second TTL. If
`subscribed_apps` fails and the token was never persisted, the operator
must make the business redo the whole Embedded Signup flow. Persisting
the token first converts an unrecoverable failure into a one-click
idempotent retry (`POST /onboarding/retry-subscribe`).

### 6.5 `meta-api.ts` additions

New exported helpers, all following the file's named-parameters
convention (which exists because swapped positional args were found four
times — the convention is load-bearing per the file's own comment):

```ts
exchangeEmbeddedSignupCode({ code, appId, appSecret, apiVersion? }): Promise<BusinessToken>
getBusinessClientId({ accessToken, apiVersion? }): Promise<string | null>   // /me?fields=client_business_id
getPhoneNumberCoexistenceState({ phoneNumberId, accessToken, apiVersion? }): Promise<CoexistenceState>
requestSmbAppDataSync({ phoneNumberId, accessToken, syncType, apiVersion? }): Promise<{ requestId: string }>
debugBusinessToken({ accessToken, appAccessToken, appsecretProof, apiVersion? }): Promise<TokenDiagnostics>
```

Plus a `shouldRegisterPhoneNumber({ connectionMode, onboardingEvent, pin, alreadyRegistered })`
pure function — the single decision point for §2.6, unit-testable
without a network.

### 6.6 Graph API version handling

Coexistence-only endpoints (`smb_app_data`, `is_on_biz_app`,
`platform_type`) are documented against **v25.0** (M4); WACRM pins
**v21.0** (`meta-api.ts:14`).

Design: add an optional `apiVersion` to the args of the new helpers,
defaulting to a new `META_COEXISTENCE_API_VERSION = 'v25.0'` constant,
and leave `META_API_VERSION` untouched. Bumping the global version
changes the behaviour of every existing send, template, and media call,
which the repo's "smallest correct change" rule forbids inside this
work. A global version migration is a separate, later task and should be
tracked on its own. See §15 U7 — the existence of these fields on v21.0
is unverified, so the override is not optional belt-and-braces.

### 6.7 `appsecret_proof`

`appsecret_proof = sha256(access_token + app_secret)` (M8). It is
documented as **Required** for the BISU token management API and
recommended for server-to-server calls generally.

Today `META_APP_SECRET` is a comma list of bare secrets and
`META_APP_ID` is a single value, so there is no reliable way to know
which secret belongs to which app. Design:

- For coexistence rows, `token_app_id = META_APP_ID` **by definition** —
  Embedded Signup can only be launched by the app whose `config_id` is
  used, so the app is known and there is no ambiguity in the common
  single-app deployment. Add a `resolveAppSecretForId(appId)` helper
  that returns the single configured secret when exactly one is set.
- Add an **optional** `META_APP_SECRETS_JSON` env var
  (`{"<appId>":"<secret>"}`) for multi-app deployments. Absent ⇒ fall
  back to the single-secret path, and if there is more than one secret
  and no map, log a warning and send without the proof rather than
  guessing. Backward compatible by construction: an existing deployment
  that sets neither behaviour is identical.
- `appsecret_proof` is computed per request and **never persisted or
  logged**.

### 6.8 `/debug_token` — optional, redacted

`token_scopes`, `token_expires_at` and `token_client_business_id` are
nice to have. `client_business_id` is cheap (`/me?fields=
client_business_id`). `debug_token` requires an app access token, is
rate-limited by Meta, and returns the token itself in the response — so
if it is added at all:

- call it only on explicit admin action ("Verify token"), never on a
  hot path;
- store **only** `expires_at` and the scope list;
- log nothing from the response body;
- never return it to the client.

Phase 3 ships with `token_expires_at = NULL` (Meta's documented default)
and adds the probe in Phase 5.

---

## 7. Webhook / echo handling design

### 7.1 `processWebhook` becomes a per-field dispatch

Current structure (verified at `route.ts:266–367`):

```
if (isTemplateWebhookField(change.field)) { …; continue }
if (value.statuses) { … }
if (!value.messages || !value.contacts) continue
```

That works only because two fields share one value shape. With seven
fields it stops being readable and, more importantly, the
`!value.contacts` guard sits where it would silently swallow echoes,
history, and state-sync deliveries. The coexistence fields must be
routed **before** that guard.

Proposed shape — a dispatch table, refactored **inside
`processWebhook` only**:

```ts
type ChangeRouter = (ctx) => Promise<void>

const CHANGE_ROUTERS: Record<string, ChangeRouter> = {
  messages:                  routeMessagesChange,        // existing behaviour
  smb_message_echoes:        enqueueEchoChange,
  history:                   enqueueHistoryChange,
  smb_app_state_sync:        enqueueStateSyncChange,
  account_update:            handleAccountUpdateChange,
}
// message_template_* handled by the existing isTemplateWebhookField branch,
// which keeps priority so no behaviour changes there.
```

Unknown field ⇒ log at `warn` with `change.field` and drop. Never a
non-2xx: M9 says Meta retries any non-200 for up to 7 days, and an
unrecognised field must not generate seven days of redelivery.

`GET` (verification handshake) and the `POST` signature path are
**unchanged**.

### 7.2 Echo ingestion and processing

`smb_message_echoes` is enqueued (§5.3) and drained. Echo handling
reuses as much of `processMessage` as is safe, via an extracted shared
`persistInboundMessage()` core — but the divergences are large enough
that a separate, smaller function is clearer:

| Step | Inbound (`messages`) | Echo (`smb_message_echoes`) |
| --- | --- | --- |
| tenant | `phone_number_id` → `whatsapp_config` | same lookup, but **verify `connection_mode='coexistence'`**; a non-coexistence row ⇒ log + drop (echoes must not exist there) |
| customer identity | `messages[].from` / `contacts[].wa_id` / BSUID | **`message_echoes[].to`, phone only.** No BSUID is available. Normalise through `normalizePhone` because `to` may be `+E.164` or digits (§15 U8) |
| direction | `sender_type='customer'` | `sender_type='agent'`, `source='business_app'` |
| initial status | `'delivered'` | `'sent'` (no live status webhooks exist — §2.10) |
| timestamp | `messages[].timestamp` | `message_echoes[].timestamp` |
| media | `parseMessageContent` + mirror | same parser, `mirror` path `account-<id>/inbound/…`; prefer the `id` → `getMediaUrl` route, fall back to an inline `url` if present (§15 U4) |
| conversation | find-or-create | find-or-create by contact, same `(account_id, contact_id)` rule |
| idempotency | `(conversation_id, message_id)` upsert | **identical** — same wamid, same index |
| unread bump | yes | **no** |
| reopen closed conversation | yes | **no** |
| broadcast reply flag | yes | **no** |
| flows | yes | **no** — an agent already spoke from their own phone; a bot must not answer them |
| automations | 5 triggers | **no** |
| AI auto-reply | yes | **no** |
| public `message.received` | yes | no; a distinct event is proposed in §15 / §12 |
| `last_message_text` / `last_message_at` | via `bump_conversation_on_inbound` | **yes**, via a plain UPDATE (no unread increment) so the inbox preview stays correct |

`broadcast_recipients` must **not** be matched on an echo wamid: echoes
are not broadcast sends, and matching would flip a `delivered` recipient
to `replied` via `flagBroadcastReplyIfAny`. Keeping echo handling out of
that function is the control.

### 7.3 `edit` and `revoke` (both fields)

`smb_message_echoes` documented types include `edit` and `revoke` (M10),
and the `messages` field documents the same two for customer-originated
edit/revoke (M4, M12). Both need handlers; today they fall through
`ALLOWED_CONTENT_TYPES` and are stored as the literal string
`[Unsupported message type: edit]`.

- `revoke` — `{ revoke: { original_message_id } }`. Find the original by
  wamid within the resolved conversation; set `deleted_at = now()`. If
  the original is unknown, log and no-op (the row may predate our
  history). Never hard-delete.
- `edit` — `{ edit: { original_message_id, message: { type, … } } }`.
  Re-parse `edit.message` through the existing content parser and
  `UPDATE messages SET content_text, media_type, media_url … WHERE
  conversation_id = ? AND message_id = ?`. Set
  `messages.edited_at`? No — `updated_at` is not on `messages`; the
  edit is visible because the content changed. Keep it to the content
  update to avoid a schema addition.
- Both are idempotent by construction (UPDATE, not INSERT), so Meta's
  7-day retry is harmless.

### 7.4 History ingestion

Per `history[]` entry:

1. **`errors[0].code === 2593109`** and no `metadata` ⇒ the business
   declined sharing. Set `onboarding_state='sync_declined'`, store the
   `error_data.details` text for the UI, mark the queue row processed.
   **Not** an error, not a retry.
2. Otherwise read `metadata.{phase, chunk_order, progress}` and update
   `whatsapp_config.history_sync_*` **monotonically**
   (`GREATEST(history_sync_progress, $new)`; `phase = max(...)`) so an
   out-of-order redelivery cannot walk progress backwards.
3. For each `threads[]`:
   - `threads[].id` is the WhatsApp **user** ⇒ the contact key (phone).
   - `messages[].from` is **either** the business number **or** the
     user's number. Direction is decided by comparing `from` against
     `metadata.display_phone_number` via `normalizePhone`, never by
     position. This is a robustness requirement, not a nicety: M14
     documents `from` as "the business customer's phone number, OR the
     WhatsApp user's phone number".
   - `sender_type` = `'agent'` if business→user, `'customer'` if
     user→business; `source='history_sync'`.
   - `history_context.status` maps onto the existing CHECK
     (`sending|sent|delivered|read|failed`):
     | Meta | WACRM |
     | --- | --- |
     | `PENDING` | `sending` |
     | `SENT` | `sent` |
     | `DELIVERED` | `delivered` |
     | `PLAYED` | `delivered` (nearest true value; voice-note semantics) |
     | `READ` | `read` |
     | `ERROR` | `failed` |
     `PLAYED` and `PENDING` are **not** in the existing CHECK and must
     not be written raw. `PLAYED` is a documented instance of
     ambiguity — there is no `played` value in the schema and inventing
     one would widen a CHECK for one message type. Mapping to
     `delivered` is a deliberate, documented loss; flag for product
     confirmation.
   - `to` is present only for SMB message echoes (M14) — if present the
     message is one WACRM may already have as a live echo. The
     `(conversation_id, message_id)` upsert absorbs it.
   - Timestamps come from `messages[].timestamp`, not `now()`, so
     history ordering is truthful.
4. `progress === 100` ⇒ `history_sync_complete`.
5. `type === 'media_placeholder'` ⇒ see §7.5.

Side-effect policy for history: **contacts yes, conversations
conditional, nothing else.** No unread bumps, no reopen, no flows, no
automations, no AI, no public webhooks. Importing 180 days of a busy
business would otherwise fire thousands of `first_inbound_message`
triggers and send thousands of AI replies.

### 7.5 The `media_placeholder` decision

M14: a media message first arrives as `type: "media_placeholder"` with
**no contents**, and a **separate** history webhook carries the media
asset id — but only for media sent within **14 days**.

Two candidate policies:

| Policy | Behaviour | Trade-off |
| --- | --- | --- |
| **A (recommended)** — skip placeholders | Do not insert a row for `media_placeholder`. The follow-up webhook creates the real row. | Simple, keeps the "first insert wins" idempotency boundary pure. Gap: media older than 14 days of onboarding produces **no row at all** — a message silently missing from a thread rather than a broken one. |
| B — insert then enrich | Insert a placeholder row, then `UPDATE` it when the media webhook arrives. | Requires an explicit exception to `ignoreDuplicates: true`, i.e. distinguishing "replay" from "enrichment" in the idempotency boundary. That boundary is the most load-bearing invariant in the webhook (#367); adding an exception to it is a much larger risk than a known gap. |

**Recommendation: A.** The gap is bounded (14 days of media before
onboarding) and it degrades to "the message is absent", which is
recoverable. B degrades to "the same message renders twice or with no
attachment", which is not.

### 7.6 Conversations created by history — a product decision, not a
technical one

Backfilling 180 days can create tens of thousands of conversations that
appear in the inbox overnight, with `unread_count` semantics that mean
nothing.

Recommended shape:

- create **contacts** (so the business's address book is represented and
  so a later live message finds the right row);
- create **conversations** for history threads, but with
  `status='closed'` and `source='history_sync'` on the conversation's
  first message, so they do not flood the default inbox view;
- add an account setting `show_imported_history` (default **false**)
  that the inbox filter honours;
- never create a conversation for a `state_sync` contact.

This needs explicit product sign-off. The alternative — "don't create
conversations at all" — leaves a customer with a contact but an empty
thread when they next write, which reads as data loss to the business.

### 7.7 `smb_app_state_sync` — contacts

- `action:'add'` ⇒ `findExistingContact` by
  `phone_normalized`; if absent, insert a contact with
  `source='whatsapp_business_app'`, `name = full_name ?? first_name ??
  phone`. Reuse `contactIdentityPatch` semantics: never clobber a
  hand-edited name with a phone-book name.
- **Do not** create a conversation and **do not** fire
  `new_contact_created` / `first_inbound_message` automations. Nobody
  messaged anyone; firing those triggers on a 5,000-contact import would
  be a false-positive storm.
- `action:'remove'` ⇒ **no destructive delete.** The contact may have
  real conversation history in WACRM. Record nothing but a log line and,
  at most, a future nullable `contacts.source_removed_at`. Destructive
  sync semantics are out of scope for this design.
- Add a nullable `contacts.source` only if the inbox needs to label
  these; otherwise skip the column.

### 7.8 `account_update` — WACRM handles none of these today

Tenant resolution: `entry.id` is the **WABA id**, so resolve via
`whatsapp_config.waba_id` — the pattern `template-webhook.ts` already
uses (issue #534). 0 rows ⇒ log + drop.

| Event | Action |
| --- | --- |
| `PARTNER_REMOVED` with `disconnection_info` | `status='disconnected'`, `connected_at=NULL`, `onboarding_state='offboarded'`, store `disconnection_reason` + `disconnection_initiated_by`. **Never** call `/register` or `/deregister`. Surface a prominent banner with the reason. |
| `PARTNER_REMOVED` without `disconnection_info` | Same, reason `null`. |
| `PARTNER_APP_UNINSTALLED` | `token_revoked_at=now()`, `status='disconnected'`, `onboarding_state='offboarded'`, and **clear `onboarding_state` guidance to re-run Embedded Signup** — the stored token is dead. Do not delete the row; the business may re-authorise. |
| `ACCOUNT_OFFBOARDED` | `status='disconnected'`, `onboarding_state='offboarded'`. |
| `ACCOUNT_RECONNECTED` | `status='connected'`, `onboarding_state='ready'`, clear `disconnection_*`. |
| `ACCOUNT_DELETED` / `ACCOUNT_RESTRICTION` / `ACCOUNT_VIOLATION` / `DISABLED_UPDATE` | `status='disconnected'`, `onboarding_state='failed'`, `onboarding_error_step='account_update'`, store `restriction_type` / `banned_state` in the existing free-text `onboarding_error`. |
| `PARTNER_APP_INSTALLED` / `PARTNER_ADDED` | Log only. |
| Everything else (PLBV, pricing tier, ad account, auth-intl, MM-Lite) | Log only. These are valuable later, not in this scope. |

Handling `ACCOUNT_RESTRICTION` in this change is a genuine improvement
over today (WACRM currently discovers enforcement only as a send error),
but it is **additive**: no existing branch changes behaviour.

### 7.9 `messages`-field coexistence artefacts

Both land in the existing `messages` branch and need explicit handling
in `processMessage`:

1. **`errors[0].code === 131060` on an inbound message** ⇒ transient
   "message currently unavailable". Do **not** insert a message row
   (there is no content), do **not** bump unread, do **not** fire
   automations or AI, do **not** return non-2xx. Log at `info` with
   `message.id` and the waba id. Optional: append a system note on the
   conversation. This must ship **with** coexistence enabled, because
   today it would write `[Unsupported message type: unsupported]` into
   the customer's thread and — worse — the row would be persisted, so the
   idempotency index would permanently block the real message when it is
   redelivered seconds later. That is a genuine, user-visible bug this
   design must prevent.
2. **`type: 'edit'` / `type: 'revoke'`** ⇒ §7.3.
3. **`unsupported` with `131051`** (genuinely unsupported type) ⇒ keep
   the current `[Unsupported message type: X]` behaviour; it is honest
   and already covered by the existing test.
4. `contacts[].identity_key_hash` ⇒ add to `WaContactPayload` as an
   optional field and ignore it. Only present when the identity-change
   check is enabled, which coexistence does not require.

---

## 8. Message identity / idempotency design

### 8.1 The identity gap is real and unavoidable

`wa-identity.ts` (issue #519) establishes that a BSUID is the *better*
key and that a username-only sender arrives with **no phone number at
all** (`messages[].from` absent, only `from_user_id`). It is careful to
backfill the BSUID onto a known phone contact.

`smb_message_echoes` has no `contacts[]` and no BSUID fields at all
(M10) — the customer is only `to`, a phone number. So:

- a contact keyed on **BSUID with `phone = ''`** **cannot be resolved
  from an echo**. Its `wa_user_id` is opaque and the echo carries no
  counterpart.
- a contact keyed on **phone** resolves normally, and the echo can
  additionally backfill `wa_username`/name if the CRM ever has them from
  a later inbound `messages` delivery.
- a **new** customer who has only ever been seen via an echo gets a
  phone-only contact. If they later message from a username-only
  account, `findContactByWaUserId` misses and the phone fallback in
  `resolveInboundIdentity` (which reads `contacts[].wa_id`) also misses,
  so a second contact is created. This is the pre-existing #519
  failure mode, not a new one, but coexistence makes it **more likely**,
  because the business can now talk to people from the app before the
  first `messages` delivery ever arrives.

Mitigations, in order of value:

1. **Do not claim otherwise in the UI.** The inbox handle already falls
   back through `contactHandle()` (phone → `@username` → BSUID); reuse
   it unchanged.
2. **Log, don't merge.** When an echo cannot resolve a contact, log the
   count. If the rate is non-trivial, the answer is a product feature
   (a contact-merge suggestion), not a heuristic.
3. **No automatic fuzzy matching on echoes.** Guessing that two
   identities are the same person from message content is how CRMs
   corrupt contact records. Explicitly out of scope.
4. Document the gap in `docs/whatsapp-architecture.md` when the feature
   lands, alongside the existing #519 note.

### 8.2 The wamid and `(conversation_id, message_id)`

The wamid is Meta's global per-message identifier and is the same
whether the message arrived live, as a `history` backfill, or as an
`smb_message_echoes` echo. Consequences:

- **No new uniqueness mechanism is needed.** The existing
  `idx_messages_conversation_message_id` (migration 037) already makes
  echo and history inserts idempotent, and
  `ignoreDuplicates: true` + `.select('id')` correctly identifies a
  replay.
- **First-writer-wins is a real property.** If a message arrives first
  as a bare history row and later as an echo, the later, richer payload
  is discarded. This is acceptable because history and echo carry the
  same content for the same wamid — and it is the same trade-off the
  current boundary already makes for Meta's 7-day retries.
- **Echoes never carry statuses**, so `handleStatusUpdate` cannot
  accidentally regress an echo row. (Today it updates 0..N rows by
  wamid with no `phone_number_id` filter — a pre-existing weakness
  documented as limitation #13 in `whatsapp-architecture.md`.)
  Coexistence makes more messages share a deployment, so that weakness
  becomes somewhat more likely to matter. Widening the status UPDATE to
  rows in the config's account is a small, self-contained improvement —
  recommended, but explicitly **out of scope for Phase 3** so it does not
  entangle the coexistence change.
- **`broadcast_recipients.whatsapp_message_id` must not be matched on an
  echo** (§7.2).

### 8.3 Queue-level idempotency

Meta retries any non-200 for **up to 7 days** (M9). A `history` chunk
can therefore be redelivered after `progress: 100`, and an echo can be
redelivered days later. `UNIQUE (field, payload_digest)` in
`whatsapp_webhook_queue` makes ingestion idempotent at the door; the
`messages` unique index makes application idempotent at the core. Two
layers, because the queue row is written *before* the message row and a
crash between the two would otherwise re-enqueue forever.

`payload_digest` is `sha256` of a canonical JSON serialisation of the
`change` object (stable key order). It is a digest, not a secret.

---

## 9. UI / UX flow

### 9.1 Structure

`src/components/settings/whatsapp-config.tsx` is already 1048 lines and
owns the entire connection surface (form, health check, verify
registration, reset, media-mirror toggle, error rendering). Growing it
would make the coexistence work unreviewable. Plan:

- `whatsapp-config.tsx` gains a **mode selector** at the top and
  delegates.
- New sibling `src/components/settings/whatsapp-coexistence.tsx` owns
  the coexistence panel.
- Shared error/status presentation is extracted rather than duplicated,
  reusing `explainMetaError` / `metaErrorPayload` /
  `MetaConnectStep` so coexistence errors read identically to today's.

### 9.2 Mode selector

Two cards at the top of *WhatsApp connection*:

- **Connect manually** — today's form, unchanged. Sub-text: "Use a
  Meta System User access token and paste the IDs. The number will not be
  available in the WhatsApp Business app."
- **Connect your WhatsApp Business app** — coexistence. Sub-text:
  "Keep using the WhatsApp Business app and add a shared inbox. Requires
  a Meta app configured as a Solution Partner or Tech Provider."

When the deployment is not configured (no `META_APP_ID`, no
`META_EMBEDDED_SIGNUP_CONFIG_ID`, flag off, or the operator is not a
partner), the second card renders **disabled** with the exact reason and
the env var or dashboard step needed. Not hidden — a hidden option
generates support tickets.

### 9.3 Coexistence onboarding checklist

Rendered from `GET /api/whatsapp/onboarding/state`:

| Step | State | UI |
| --- | --- | --- |
| Launch Embedded Signup | `idle` / `session_created` | "Connect WhatsApp Business app" button |
| Business token received | `token_exchanged` | check |
| WABA subscribed to this app | `waba_subscribed` | check |
| Coexistence active on Meta | `is_on_biz_app && platform_type === 'CLOUD_API'` | check, or a red "not active — the number may not have completed onboarding" |
| Contacts synced | `contacts_sync_requested_at` | check + count, once-only |
| History synced | `sync_started` → `progress%` | progress bar: `phase n/2`, `progress %`, **24-hour countdown** |
| History declined by business | `sync_declined` | informational, not an error: "The business chose not to share chat history." |
| Window expired | `sync_expired` | warning: "The 24-hour synchronization window elapsed. Disconnect and connect again." |
| Disconnected | `offboarded` | red banner with `disconnection_reason` (humanised) and `initiated_by` |
| Failed | `failed` | error text + `meta{code, subcode, fbtrace_id, step}` + retry |

Every countdown is computed from
`history_sync_deadline_at` on the server, not in the browser, so a
clock-skewed client cannot misreport urgency.

### 9.4 Before the business commits

Because coexistence has **irreversible user-visible effects** (M4's
feature comparison: disappearing messages, view-once and live location
are **disabled** for 1:1 chats; broadcast lists become read-only; all
companion devices are unlinked), the launch step must show a short,
plain disclosure first:

- disappearing / view-once / live location will stop working for 1:1
  chats;
- broadcast lists become read-only;
- linked devices are unlinked and must be re-linked;
- WhatsApp for Windows and WearOS are not supported, and messages from
  those clients will not reach WACRM;
- throughput is fixed at 20 mps;
- the business can disconnect later from the app, but WACRM cannot
  deregister the number for them.

This is a one-time acknowledgement, stored as
`whatsapp_config.coexistence_enabled_at` + `coexistence_enabled_by`.

### 9.5 Changes to existing UI

| Component | Change |
| --- | --- |
| `whatsapp-config.tsx` mode selector | new |
| "Not registered" banner | suppressed when `registration_mode='skipped_coexistence'` — the number *is* registered, by the business |
| "Reset Configuration" (`DELETE /api/whatsapp/config`) | for a coexistence row the copy must say it removes WACRM's connection only, and that Meta-side offboarding is done in the WhatsApp Business app (M4). Do **not** call `/deregister` |
| "Verify with Meta" (`/config/verify-registration`) | add a 4th check for coexistence rows: `is_on_biz_app` + `platform_type` |
| Media-mirror toggle | unchanged |
| Inbox message list | filter `deleted_at IS NULL`; label `source='business_app'` rows as "sent from the WhatsApp Business app"; `show_imported_history` off by default (§7.6) |
| Contact list | optional `contacts.source` label for phone-book imports |
| i18n | all new strings under `Settings.whatsappCoexistence.*` in `messages/en.json` **and** `ko.json`, `pt.json`, `es.json`. The parity test in `src/i18n/messages.test.ts` fails on missing keys — the two known pre-existing `pt`/`es` failures under `Contacts.importModal.*` are unrelated and must not be conflated with this work |

### 9.6 Client SDK loading

`next/script` with `strategy="lazyOnload"`, loaded **only** when the
coexistence flow is launched. `appId`, `graphVersion`, `configId` and
`extras` come from `GET /api/whatsapp/onboarding/session`.

Explicit trap: `NEXT_PUBLIC_META_APP_ID` would be inlined into the client
bundle **at build time**, which defeats per-deployment configuration for
a self-hosted template. The app id and config id must be served from a
route. This mirrors the existing `ALLOWED_INVITE_HOSTS` /
`NEXT_PUBLIC_SITE_URL` reasoning in `.env.local.example` and
`src/lib/auth/invitations.ts`.

The `message` event listener must check
`event.origin.endsWith('facebook.com')` exactly as Meta's reference
implementation does (M2) before `JSON.parse(event.data)`.

---

## 10. Migration / backward compatibility

### 10.1 Existing deployments

| Surface | After upgrade |
| --- | --- |
| `POST /api/whatsapp/config` | identical, plus a 409 only if the row is `coexistence` (impossible on a pre-existing row) |
| `GET /api/whatsapp/config` | identical plus two additive response fields |
| Webhook `GET` | byte-identical |
| Webhook `POST` signature path | byte-identical |
| Webhook `messages` / `statuses` / `message_template_*` | byte-identical except the new `131060` short-circuit, which only fires on a code that today produces a wrong persisted row |
| `whatsapp_config` rows | `connection_mode='api_only'`, `token_type='system_user'`, `onboarding_state='idle'` — all correct defaults |
| `messages` rows | `source IS NULL`, `deleted_at IS NULL` — no backfill, no behaviour change |
| Send path | untouched |
| Broadcasts, flows, automations, AI | untouched |
| Public REST API `/api/v1` | untouched; new response fields are additive. `POST /api/v1/messages` continues to write `source` NULL |
| Public outbound webhooks | existing event names and payloads unchanged |
| Env | new vars are **optional**; unset ⇒ coexistence unavailable with a clear message |
| `ENCRYPTION_KEY` | unchanged; no re-encryption of any existing row |
| Container path (`docs/docker.md`) | no scheduler; the history drain endpoint needs an external pinger like `/api/automations/cron` and `/api/flows/cron` — note this in `docs/docker.md` |

Rollback: every migration is additive and idempotent per repo convention,
so downgrading the application code leaves the new columns in place,
unused and harmless. No column is dropped, so no data migration is
required to reverse.

### 10.2 Deploy ordering

1. Apply migrations 043–046 (`supabase db push`).
2. Assert with `supabase db query --local --file
   supabase/ci/verify-schema.sql`.
3. Deploy code. Coexistence is **inert** because the env flag is off.
4. Only then configure the Meta app (§14) and set the env vars.

Nothing in step 1 or 3 changes existing behaviour, so the usual
"migrate then deploy" ordering is safe.

### 10.3 Coexistence rows and `redeem_invitation`

Migration 019's `redeem_invitation` refuses an account that already owns
a `whatsapp_config`. `UNIQUE (account_id)` is unchanged, so an account
that has onboarded a coexistence number still cannot accept a second
invitation. No change needed — but the refusal message ("already owns a
WhatsApp configuration") becomes slightly less accurate, since the
account now has a partner-owned WABA. Worth a copy tweak in a later
change; not required for correctness.

### 10.4 Explicitly out of scope

Multi-number-per-account, `WABA → whatsapp_config` normalisation,
cross-account identity linkage, granular per-client BISU tokens, token
rotation via the BISU management API, 20 mps throughput backoff, and the
Conversions API for business messaging that M4 mentions.

---

## 11. Security model

Reviewed with the `vibe-security` skill. The design was written to
avoid the failure classes that skill enumerates; the notes below record
the specific controls and the specific risks that remain.

### 11.1 OAuth / token handling

| Control | Rationale |
| --- | --- |
| Code exchange is **server-to-server only** | M5/M6: "Do not use client-side requests." A client-side exchange would put `app_secret` in the browser. |
| The browser sends only `{ session_id, nonce, code, session_event }` | Prevents an attacker (or a buggy client) from binding an arbitrary WABA, or injecting their own token, by editing the request body. **This is the single most important control in the design.** |
| Unknown body keys are rejected, not ignored | A body carrying `access_token` is a bug or an attack; both deserve a 400. |
| `complete` ignores the browser's asset ids and re-derives from Meta | The session event is attacker-controllable. It is stored as `finish_event` for logging and reconciled against Meta, never trusted. |
| The exchange is **inline**, never queued | 30-second TTL. A queue would guarantee expiry. |
| The code is never persisted, never logged, never returned | Same posture as `account_invitations.token_hash`. |
| `appsecret_proof` derived per request from `META_APP_ID` | Never persisted. `app_id` is public; only the hash goes on the wire. |
| `/debug_token` is off the hot path and redacted before storage | M7 warns tokens are opaque and variable-length; the response contains the token itself. |
| `META_APP_SECRET` handling is unchanged | Already fail-closed when unset, already constant-time, already supports a list. No weakening. |
| `ENCRYPTION_KEY` handling is unchanged | AES-256-GCM, 16-byte auth tag, fail-closed on decrypt failure. `token_type` and metadata columns store **no secret values**, so they are safe under a RLS-readable `SELECT`. |

### 11.2 State / CSRF

The existing `POST /api/whatsapp/config` is cookie-authenticated with
**no CSRF token**; today that is mitigated by requiring an
`access_token` the attacker cannot read. The coexistence path removes
that incidental mitigation, because the server accepts a code anyone can
obtain.

Controls:

1. **Server-minted, single-use, account-bound, short-TTL nonce.**
   `nonce_hash = sha256(nonce)`; only the hash is stored; the plaintext
   is returned exactly once. Mirrors `account_invitations`.
2. **Atomic consume.** A `service_role`-only RPC does
   `UPDATE … WHERE consumed_at IS NULL AND expires_at > now() AND
   account_id = ? RETURNING id`. Concurrent double-submits cannot both
   win, and a lost race cannot exchange a code twice.
3. **Origin and Host allowlist** on `complete`, reusing the
   `ALLOWED_INVITE_HOSTS` pattern already in
   `src/lib/auth/invitations.ts`. Defence in depth: Meta's own
   strict-redirect-URI setting is not something WACRM can rely on, since
   the `complete` call is made by WACRM's own page.
4. **SameSite cookie behaviour is inherited** from Supabase SSR
   cookies. The nonce is the real defence; SameSite is not relied on
   alone.
5. **Rate limiting** on `session` and `complete` via the repo's
   `checkRateLimit`, keyed on user **and** client IP. A `complete` that
   can be called freely lets an attacker burn Meta operations and
   exhaust the 7-day retrial budget of a real business. The limiter is
   in-memory and per-instance — a documented limitation of this
   repository, acceptable for an admin-gated endpoint.

### 11.3 Webhook verification

- **Unchanged.** `verifyMetaWebhookSignature` over the raw bytes,
  `x-hub-signature-256`, `timingSafeEqual`, fail-closed on missing
  `META_APP_SECRET`, comma-separated secret list. The coexistence
  fields are signed by the same app secret and hit the same endpoint, so
  no new verification path is introduced.
- The `GET` handshake is unchanged. Coexistence onboarding **populates**
  `whatsapp_config.verify_token` (server-generated random value, shown
  once in the UI) so that if Meta ever re-runs the handshake — e.g. when
  the callback URL is (re)configured — the existing "any account's token
  matches" behaviour still succeeds. No new env var and no new secret
  surface.
- **New:** the drain endpoint is authenticated with `x-cron-secret`,
  returning **503** when `AUTOMATION_CRON_SECRET` is unset, exactly like
  `/api/automations/cron` and `/api/flows/cron`.
- Unknown webhook `change.field` ⇒ log + drop with **200**. Never 4xx:
  M9 says Meta retries any non-200 for up to 7 days.
- Payload sizes: the coexistence fields are queued to Postgres before
  processing precisely so a 3 MB / multi-thousand-message `history`
  delivery cannot blow the 60-second `maxDuration`. Inbound `messages`
  is unchanged and still processed inline.

### 11.4 Account isolation

- **The cross-account `phone_number_id` check is the WABA-hijack
  control.** An Embedded Signup flow returns whatever WABA the
  authenticating business admin selected, and any app admin can complete
  one. Without the check, a malicious account admin could onboard
  *someone else's* WABA and receive their inbound messages. The existing
  service-role `.eq('phone_number_id').neq('account_id')` pattern is
  reused verbatim, and `UNIQUE (phone_number_id)` backs it at the DB
  level.
- Every webhook path resolves the account from `whatsapp_config` by
  `phone_number_id` (history, echoes, state sync) or by `waba_id`
  (`account_update`) using the service role, and stamps
  `account_id` explicitly on every row it writes — identical to the
  existing webhook posture. **No webhook-derived value is ever used as a
  tenancy key directly.**
- The Echoes/history handlers derive the account the same way the current
  `messages` handler does, and add one extra assertion:
  `connection_mode === 'coexistence'`. A coexistence-only field arriving
  for an `api_only` row is dropped, not processed.
- `whatsapp_onboarding_sessions` and `whatsapp_webhook_queue` have RLS
  enabled and **no policies**, so they are reachable only with the
  service role, and every query against them filters on `account_id`.
- `messages.source` and `messages.deleted_at` inherit the existing
  conversation-membership SELECT policy. No policy change is needed and
  none is proposed.
- The `nonce` is bound to `account_id` **and** `user_id`, so a nonce
  minted by one member cannot be redeemed by another, and a nonce minted
  for account A cannot complete onboarding for account B even if the
  attacker is an admin of both.

### 11.5 Authorization boundaries

- Every new route calls `requireRole('admin')` explicitly. The middleware
  401 is a UX layer, not a gate — the `vibe-security` reference on
  `CVE-2025-29927` and `AGENTS.md` §2 both say so, and this design does
  not rely on it.
- `admin` is the right tier, not `owner` and not `agent`: connecting a
  WABA is strictly more powerful than editing settings, and
  `whatsapp_config` is already `admin+` by RLS (migration 017). Nothing
  is exposed to `agent` or `viewer`.
- `POST /api/whatsapp/config` is gated to refuse a coexistence row even
  for an admin, which is a data-integrity control rather than a
  privilege control — it prevents a well-intentioned admin from silently
  downgrading a partner-owned connection to a pasted token.
- No new public (unauthenticated) endpoint. The only unauthenticated
  surface remains `GET`/`POST /api/whatsapp/webhook`, and its
  authentication is unchanged.

### 11.6 Secrets

| Secret | Where | Notes |
| --- | --- | --- |
| `ENCRYPTION_KEY` | env, module load | unchanged; must be 64 hex |
| `META_APP_SECRET` | env, comma list | unchanged; also used for the `appsecret_proof` and the code exchange |
| `META_APP_ID` | env, single | unchanged semantics; now also required for coexistence. **Public value — safe to return to an authenticated client via a route, never as `NEXT_PUBLIC_*`** |
| `META_EMBEDDED_SIGNUP_CONFIG_ID` | env, new | public config id; route-served, not `NEXT_PUBLIC_*` |
| `META_EMBEDDED_SIGNUP_ENABLED` | env, new | boolean, default **off** |
| `META_APP_SECRETS_JSON` | env, new, **optional** | `{"<appId>":"<secret>"}` for multi-app `appsecret_proof`; absent ⇒ single-secret fallback |
| BISU token | `whatsapp_config.access_token`, AES-256-GCM | **never** returned by any route. `state` returns metadata only |
| Exchange code | never stored | single-use, 30 s |
| Onboarding nonce | `nonce_hash` only | plaintext returned once |
| 2FA PIN | never stored | unchanged from today |
| Meta client secret | never sent to the browser | exchange is server-side only |

No secret is written to a log line, a response body, a comment, a
commit, or AI memory. `console` output for onboarding logs
`account_id`, `phone_number_id`, `waba_id`, `onboarding_state`,
`finish_event` and Meta's `code`/`subcode`/`fbtrace_id` — never a token,
code, nonce, or proof. `fbtrace_id` is the identifier Meta support asks
for and is safe to log; it is not a credential.

### 11.7 Residual risks (accepted, not mitigated)

| Risk | Severity | Why accepted |
| --- | --- | --- |
| A Meta app **admin/developer/tester** can complete Embedded Signup as the operator's own business and grant the app a business token — that is Embedded Signup's designed trust model (M1) | Medium | Unavoidable; it is the platform's model. Mitigated by the account-scoped nonce, the `admin+` gate, and the cross-account uniqueness check |
| The deployment's own Meta app can now be granted a business token for **any** business that installs it — i.e. WACRM becomes a credential issuer for its own app | Medium | Inherent to a partner app. Requires partner status, which the operator must already hold. Every token is per-account, per-row, and revocable via `PARTNER_APP_UNINSTALLED` |
| `ENCRYPTION_KEY` compromise exposes coexistence tokens as well as existing ones | — | Pre-existing, unchanged. Any new secret adds nothing here |
| Meta app secret compromise ⇒ token exchange and `appsecret_proof` forgery | — | Same as today's webhook-verification dependency. Not a new class |
| History backfill is a bulk data import driven by Meta | Low | Bounded by the once-only rule and the 24-hour window; queued and rate-bounded |

### 11.8 No broad refactor

The design touches only the WhatsApp integration. It does **not**
revisit: the 001-era `"Service role can insert messages"` policy
(`WITH CHECK (true)`, already flagged in
`docs/database-architecture.md`), `profiles.role` legacy cleanup,
`ENCRYPTION_KEY` rotation, `META_APP_ID` single-valuedness, or
`middleware.ts` → `proxy.ts`. Those remain separately tracked items.

---

## 12. Error / recovery scenarios

| # | Scenario | Detection | Behaviour | Recovery |
| --- | --- | --- | --- | --- |
| E1 | `META_EMBEDDED_SIGNUP_ENABLED` off, or `META_APP_ID` / config id unset | server precondition | coexistence card disabled with the exact env var named | operator configures |
| E2 | Caller is `agent`/`viewer` | `requireRole('admin')` | 403 | ask an admin |
| E3 | Business abandons the popup at a non-final screen | `event: 'CANCEL'` with `current_step` | session row records `finish_event='CANCEL'`; `onboarding_state` back to `idle` | retry; `current_step` stored for diagnosis against M2's abandoned-flow-screen list |
| E4 | Business reports an in-flow error | `event: 'CANCEL'` with `error_code`/`error_message`/`session_id` | stored for support quoting; state `idle` | operator reads the error, retries |
| E5 | **Code expired** (>30 s before `complete`) | `oauth/access_token` 4xx/5xx | **token already not stored**; `onboarding_state='code_expired'`→`failed`, `onboarding_error_step='token_exchange'`; no retry attempted | business must redo Embedded Signup. UI says so explicitly. No auto-retry is possible |
| E6 | `subscribed_apps` fails after a successful exchange | `subscribe_waba` failure | **token IS already persisted**; `onboarding_state='failed'`; HTTP 200 with `retryable: true` | one-click `POST /onboarding/retry-subscribe`; **no re-run of Embedded Signup** |
| E7 | Derived `phone_number_id` already claimed by another account | service-role conflict query | 409 with the existing reason text | operator contacts the other account owner. **Never** overwrite |
| E8 | Business admin selects a WABA the app cannot use (`listWabaPhoneNumbers` 403) | `waba_phone_numbers` failure | 400/502 with `meta{code, subcode, fbtrace_id}` | fix the asset grant in Business Manager |
| E9 | `is_on_biz_app` is `false` or `platform_type !== 'CLOUD_API'` after onboarding | coexistence probe | `onboarding_state='failed'`, `onboarding_error_step='verify_coexistence'`. **Do not call `/register`** | the business did not complete the app-side connect; redo the flow |
| E10 | Business declines chat-history sharing | `history[].errors[0].code === 2593109` | `onboarding_state='sync_declined'` — informational, not an error | nothing; the business can share later only via a new onboarding |
| E11 | 24-hour sync window elapses | `now() > history_sync_deadline_at` (server clock) | `onboarding_state='sync_expired'`, red banner | offboard + re-run Embedded Signup. Not automatable |
| E12 | Double-clicked sync | local `history_sync_requested_at IS NOT NULL` | 200 with `already_requested: true`, **no Meta call** | none needed; the button is disabled |
| E13 | `history` chunk redelivered days later (7-day retry, M9) | `UNIQUE (field, payload_digest)` conflict | enqueue is a no-op; if it did land, the `messages` index absorbs it and `progress` moves only via `GREATEST` | none needed |
| E14 | `131060` on first contact after onboarding | `message.errors[0].code === 131060` | log at `info`; **no row inserted**, no unread bump, no automations, 200 | expected; resolves in seconds (M4). Message is visible in the WhatsApp Business app |
| E15 | Message from an unsupported companion (Windows/WearOS) | no webhook at all | nothing to handle — **silent loss** | warned about in the pre-flight disclosure (§9.4) |
| E16 | Business disconnects from the app | `account_update` `PARTNER_REMOVED` + `disconnection_info` | `status='disconnected'`, `onboarding_state='offboarded'`, reason stored, red banner with a humanised reason | business reconnects in the app, then re-runs Embedded Signup |
| E17 | Business removes the app in Business Manager | `PARTNER_APP_UNINSTALLED` | `token_revoked_at` set, `status='disconnected'` | re-run Embedded Signup to mint a new business token |
| E18 | WABA restricted / banned / deleted | `account_update` restriction events | `status='disconnected'`, `onboarding_state='failed'`, reason stored | Meta enforcement path, out of WACRM's control |
| E19 | Business token expires (60-day config) or is rotated out from under WACRM | send/media/`subscribed_apps` returns an auth error | `explainMetaError` surfaces it; add an explicit `meta-error-explain.ts` branch for the Meta auth codes once identified (§15 U13) | BISU management API rotation (Phase 5) or re-run Embedded Signup |
| E20 | `history` payload exceeds 3 MB or describes thousands of messages | payload size / row count | enqueued whole, acked 200, drained in bounded batches by `POST /api/whatsapp/history/drain` | automatic; the drain endpoint is cron-pinged like the existing automation/flow crons |
| E21 | `history` contains a `media_placeholder` | type check | **not inserted** (§7.5) | the follow-up webhook creates the real row if within 14 days; otherwise the message is absent — a known, bounded gap |
| E22 | Echo cannot resolve a BSUID-only contact | no phone match, no BSUID | log the count; create a phone-only contact if none exists | no auto-merge (§8.1). Manual contact merge |
| E23 | Echo arrives for an `api_only` row | `connection_mode` check | log + drop | none; should be impossible |
| E24 | `revoke` / `edit` references an unknown wamid | conversation-scoped lookup misses | log + no-op | none; the original predates our history |
| E25 | `ENCRYPTION_KEY` differs between environments | `decrypt` throws | existing `token_corrupted` + `needs_reset` path, unchanged | re-save / re-onboard |
| E26 | Rate limit reached on `session`/`complete` | `checkRateLimit` | 429 with `reset` | retry after the window |
| E27 | `state_sync` `action:'remove'` | type check | **log only, no delete** | out of scope by design (§7.7) |

---

## 13. Test plan

Conventions: Vitest 4, `environment: 'node'`, scope `src/**/*.test.ts`,
Supabase faked at the client boundary, Meta faked at `fetch`,
`clearMocks: true`, modules tested beside their file. Route-handler logic
is tested through the extracted library, never by mounting the handler
(`src/app/api/whatsapp/webhook/route.test.ts` drives `processWebhook`
directly). No jsdom — so no component tests; UI work is verified by
typecheck/lint/build plus manual acceptance.

### 13.1 Pure modules (highest value, no I/O)

| Module | Cases |
| --- | --- |
| `src/lib/whatsapp/coexistence-mode.ts` *(new)* | `shouldRegisterPhoneNumber`: `coexistence` + any event ⇒ false; `api_only` + PIN ⇒ true; `api_only` + no PIN + already registered ⇒ false; `api_only` + no PIN + not registered ⇒ false (existing skip). Regression-lock the current behaviour for `api_only`. |
| `src/lib/whatsapp/embedded-signup-event.ts` *(new)* | Parse the session-logging `message` event: accept only `event.origin.endsWith('facebook.com')`; handle `FINISH`, `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`, `FINISH_ONLY_WABA`, `FINISH_OBO_MIGRATION`, `FINISH_GRANT_ONLY_API_ACCESS`, `CANCEL` (with and without `error_code`); reject unknown `type`; tolerate a coexistence payload carrying **only** `waba_id` (§15 U6) |
| `src/lib/whatsapp/embedded-signup-extras.ts` *(new)* | v4 ⇒ `{}`; v3/v2 ⇒ `{ featureType: 'whatsapp_business_app_onboarding' }`; v2 ⇒ `sessionInfoVersion: '3'`; assert v2 is not selectable after the 2026-10-15 flag date |
| `src/lib/whatsapp/echo-identity.ts` *(new)* | `normalizePhone` on `to` as `+16505551234` and as `16505551234` → same digits (§15 U8); `from` vs `metadata.display_phone_number` ⇒ direction `outbound`/`inbound`/`unknown`; never treat `from` as the contact |
| `src/lib/whatsapp/history-status.ts` *(new)* | `PENDING→sending`, `SENT→sent`, `DELIVERED→delivered`, `PLAYED→delivered`, `READ→read`, `ERROR→failed`, unknown ⇒ `null` (never write a raw value outside the CHECK) |
| `src/lib/whatsapp/history-progress.ts` *(new)* | `GREATEST` on out-of-order chunks; phase never regresses; `progress===100` ⇒ complete; `errors[0].code===2593109` ⇒ declined, not error |
| `src/lib/whatsapp/history-payload-digest.ts` *(new)* | canonical serialisation is stable across key order; identical change ⇒ identical digest; different change ⇒ different digest |
| `src/lib/whatsapp/coexistence-probe.ts` *(new)* | `is_on_biz_app && platform_type==='CLOUD_API'` ⇒ active; either false ⇒ not active; missing fields ⇒ unknown, never a crash |
| `src/lib/whatsapp/account-update.ts` *(new)* | map each documented `event` (+ `disconnection_info.reason` / `initiated_by`) to a state transition; unknown event ⇒ no-op |
| `src/lib/whatsapp/app-secret-for-id.ts` *(new)* | single secret ⇒ that secret; `META_APP_SECRETS_JSON` hit ⇒ that secret; miss with >1 secret ⇒ `null` + warn; unset ⇒ `null` (fail-closed for the proof) |

### 13.2 Webhook route (`route.test.ts` extensions)

- `smb_message_echoes`: inserts `sender_type='agent'`,
  `source='business_app'`, `status='sent'`; **no** unread bump; **no**
  flow/automation/AI/public-webhook dispatch; `last_message_text`
  updated; conversation found by `to`.
- Echo replay: second delivery of the same wamid inserts nothing and
  dispatches nothing.
- Echo for a non-coexistence row: dropped, logged.
- Echo `revoke`: sets `deleted_at` on the original; idempotent on replay.
- Echo `edit`: updates the original's `content_text`; idempotent.
- `history`: three phases arriving out of order still converge on
  `progress=100`; a redelivered chunk is a no-op; `2593109` sets
  `sync_declined` and inserts no rows; direction derived from `from`;
  `media_placeholder` inserts nothing; `PLAYED` is written as
  `delivered`, never as a raw value; **no** unread bump and **no**
  automation/AI dispatch for any history message.
- `smb_app_state_sync`: `add` upserts a contact and creates no
  conversation; `remove` deletes nothing.
- `account_update`: `PARTNER_REMOVED` with `disconnection_info` sets
  `status='disconnected'` + `onboarding_state='offboarded'` + reason, and
  makes **no** Meta call; `PARTNER_APP_UNINSTALLED` sets
  `token_revoked_at`; unknown event ⇒ no-op with 200.
- `messages` field, coexistence artefacts: `131060` inserts **no**
  message row and bumps **no** unread; `edit`/`revoke` handled; `131051`
  keeps today's `[Unsupported message type: …]` behaviour.
- Regression (must all still pass unchanged): existing
  `processWebhook`, `processMessage`, `parseMessageContent`,
  `handleStatusUpdate`, `isValidStatusTransition`, contact/conversation
  find-or-create, `23505` re-resolution, and the idempotency short-circuit.
- The `!value.messages || !value.contacts` guard still applies to the
  `messages` branch (regression lock).

### 13.3 Onboarding routes (new `coexistence` test files)

- `session`: admin-only (403 for agent/viewer); mints a nonce, returns
  the plaintext once, stores only the hash; disabled-reason response when
  env is missing; rate-limited.
- `complete`: rejects an unknown body key; rejects a nonce bound to
  another `account_id` or `user_id`; rejects an expired session; rejects
  a second submit after consume; rejects a bad `Origin`; succeeds and
  **persists the token before** calling `subscribed_apps`; on
  `subscribed_apps` failure the token is still stored and the response
  is retryable; returns 409 on a cross-account `phone_number_id`; the
  response body never contains the token; `appsecret_proof` is sent and
  never logged.
- `sync`: refuses a second call for the same `sync_type` without calling
  Meta; stores `request_id` and `deadline_at`; issues both calls when
  neither has been requested.
- `retry-subscribe`: idempotent.
- `state`: returns metadata and **never** a token value.

### 13.4 `meta-api.ts` additions (`meta-api.test.ts`)

- `exchangeEmbeddedSignupCode`: URL shape, `Authorization`-free GET with
  query params, success body, Meta error envelope → `MetaApiError` with
  `code`/`subcode`/`fbtrace_id` intact.
- `requestSmbAppDataSync`: both `sync_type` values, body shape, `request_id`
  extraction, paging absent.
- `getPhoneNumberCoexistenceState`: field list, `is_on_biz_app` and
  `platform_type` parsing, `null` on missing.
- **Per-call `apiVersion` override** is actually used for the coexistence
  endpoints and that the **default remains `v21.0`** for every existing
  helper (regression lock on the constant).
- `appsecret_proof` computed as `sha256(token + secret)` and attached to
  the request headers/query.

### 13.5 Migrations

Add to `supabase/ci/verify-schema.sql` (thin, outcome-only, per the
repo's stated convention):

- every new `whatsapp_config` column exists;
- `whatsapp_onboarding_sessions` exists, RLS enabled, and has **zero**
  policies (assert `count(*) = 0` from `pg_policies`);
- `whatsapp_webhook_queue` exists, RLS enabled, zero policies, and the
  `(field, payload_digest)` unique index exists;
- `messages.source` and `messages.deleted_at` exist;
- the new `redeem_whatsapp_onboarding_session` RPC exists, is
  `REVOKE`d from `PUBLIC`/`anon`/`authenticated`, and is granted to
  `service_role` only;
- every pre-existing row has `connection_mode='api_only'` and
  `token_type='system_user'`.

Then `supabase db reset --local --no-seed` and
`supabase db query --local --file supabase/ci/verify-schema.sql`, as
`docs/development-workflow.md` requires.

### 13.6 CI / harness

- Any **new module-load env read** (`META_EMBEDDED_SIGNUP_ENABLED`,
  `META_EMBEDDED_SIGNUP_CONFIG_ID`, `META_APP_SECRETS_JSON`, and the now
  co-required `META_APP_ID`) needs an entry in **both**
  `vitest.config.ts` **and** `.github/workflows/ci.yml`. This is a
  documented trap: a missing CI entry fails only in CI.
- Full pre-flight: `npm run typecheck` → `npm run lint` (warnings ≤ the
  41 baseline) → `npm test` (no failure beyond the two known i18n parity
  cases) → `npm run build`.
- i18n: add every new key to `messages/en.json`, `ko.json`, `pt.json`,
  `es.json` before running the parity test. Do not weaken the parity
  test, and do not conflate new failures with the pre-existing
  `Contacts.importModal.*` gap.
- No `.env` value, token, code, nonce, or `fbtrace_id`-bearing payload in
  any file, log line, snapshot, or commit message.

### 13.7 Manual / sandbox acceptance (no CI coverage exists)

- Embedded Signup with a **sandbox account** (M1: claimable from App
  Dashboard → WhatsApp → Quickstart → *Testing Integrations*; 30-day
  life; phone number cannot send/receive) — validates the browser flow
  and the asset-return shape.
- A real Tech-Provider test business, walking the full checklist: send
  from the Cloud API, send from the app (echo), receive inbound, receive
  the **first-contact `131060`**, decline history, accept history, and
  disconnect from the app.
- **Phase 0 spike (see §16): prove that skipping `/register` really does
  deliver `messages` and `smb_message_echoes`.** This is the single
  highest-value manual test in the whole design, because it validates the
  one place where Meta's own documentation contradicts itself.

---

## 14. External Meta App configuration

None of this is in the repository. It is operator/App-Dashboard work and
**must be done before the coexistence UI will do anything useful.**

### 14.1 Partner status (blocking)

- Solution Partner **or** Tech Provider (M4). Verify in App Dashboard /
  Meta Business Suite. Without it Embedded Signup cannot be implemented
  and coexistence is unreachable.
- Business Verification, App Review, and Access Verification raise the
  onboarding limit from 10 to 200 customers per rolling 7 days (M1).
- Advanced access via App Review is required for every permission
  requested in the login configuration (M1, M8) — without it, business
  customers cannot grant permissions and cannot onboard.

### 14.2 App type and products

- The app must be a **Business type app** (M8). Switching from a
  `None`-type app changes the app type and can revoke unsupported
  permissions; the same page documents a 30-day rollback.
- Add the **Facebook Login for Business** product. Switch from Facebook
  Login only if you intend to roll back within 30 days.

### 14.3 Facebook Login for Business configuration

- **Facebook Login for Business → Configurations → Create configuration**
  (or the *WhatsApp Embedded Signup Configuration With 60 Expiration
  Token* template — note the name contradicts the 30-second code TTL;
  see §15 U2).
- Login variation: **WhatsApp Embedded Signup**.
- Access token type: **Business Integration System User** (Tech Provider)
  — SUAT is only for Solution Partners' credit-line sharing, which WACRM
  does not do.
- Token expiration: **never expire** (matching Meta's documented BISU
  default) unless the operator wants the 60-day rotation path of §16
  Phase 5.
- Select the **Cloud API** product so v4 is selected and
  `whatsapp_business_management` + `whatsapp_business_messaging` are
  auto-selected. Selecting extra products (CTWA, Conversions API, MM
  API) changes the flow — choose deliberately.
- **Copy the configuration id** into `META_EMBEDDED_SIGNUP_CONFIG_ID`.
- Note: v4's `extras` object is **empty**; `whatsapp_business_app_onboarding`
  is still selected, but via the configuration rather than `extras`
  (M3, M4). If the operator must stay on v3, the same feature is
  selected in `extras.featureType` and `extras.version = 'v3'`.

### 14.4 Client OAuth settings

App Dashboard → **Facebook Login for Business → Settings → Client OAuth
settings**. All of the following must be **Yes** (M2):

- Client OAuth login
- Web OAuth login
- Enforce HTTPS
- Embedded Browser OAuth Login
- use Strict Mode for redirect URIs
- Login with the JavaScript SDK

### 14.5 Allowed domains and redirect URIs

- Add the WACRM origin (and every dev origin) to **Allowed domains** and
  **Valid OAuth redirect URIs**. **HTTPS only** (M2). The Flow returns
  nothing if the spawning page's domain is absent from both fields.
- This is the natural companion to the existing `ALLOWED_INVITE_HOSTS`
  env var: the two together pin both the invite origin and the Embedded
  Signup origin.

### 14.6 WhatsApp → Configuration (webhooks)

- **Callback URL** — the WACRM deployment's
  `https://<host>/api/whatsapp/webhook`. Must have a valid SSL
  certificate (M2).
- **Verify token** — generate a random value; WACRM's handshake accepts
  any account's stored `verify_token` (M4 note: this is what lets one
  callback serve many WABAs). Coexistence onboarding stores one
  server-side so a later re-verification succeeds.
- **Subscribe to fields** (App Dashboard → WhatsApp → Configuration),
  in addition to `messages`:
  - `history` — required (M4)
  - `smb_app_state_sync` — required (M4)
  - `smb_message_echoes` — required (M4)
  - `account_update` — required for Embedded Signup generally (M2)
  - `message_template_status_update`,
    `message_template_quality_update`,
    `message_template_components_update` — already a known manual
    step in `docs/whatsapp-architecture.md` limitation #9; subscribe
    while here.
  - Optionally `account_alerts`, `phone_number_quality_update`,
    `phone_number_name_update` for richer health UI later.
- **The app must be in Live mode**; some webhooks are not sent in Dev
  mode (M9). This is the usual cause of "the coexistence fields are
  enabled but nothing arrives".

### 14.7 Environment variables to set

```
META_EMBEDDED_SIGNUP_ENABLED=true
META_APP_ID=<app id>                                   # already exists; now required
META_EMBEDDED_SIGNUP_CONFIG_ID=<facebook login for business config id>
META_APP_SECRET=<app secret>                           # already exists; same app as META_APP_ID
# optional, multi-app only:
# META_APP_SECRETS_JSON={"<appId>":"<secret>","<otherAppId>":"<otherSecret>"}
```

`NEXT_PUBLIC_*` must **not** be used for `META_APP_ID` or the config id —
they are inlined at build time and would break per-deployment
configuration for a self-hosted fork.

### 14.8 Business-side prerequisites to verify per customer

- WhatsApp Business app **2.24.17+** (M4).
- A business portfolio the app can be associated with, separate from the
  customer's own portfolio (M8).
- A payment method on the WABA, or a shared credit line if the operator
  is a Solution Partner (M1, M5 Step 5) — **WACRM cannot send until this
  exists**, which is a common first-day surprise.
- The number must **not** already be on Cloud API (§4.4).
- The customer must complete the in-app **Connect → Connect to the
  Business Platform → Confirm** sequence, and decide on history sharing
  at the Confirm step.

---

## 15. Open questions / uncertainties

These are places where Meta's documentation is missing, ambiguous, or
self-contradictory, or where a product decision is genuinely open. None
should be resolved by guessing.

### Resolvable with a sandbox spike (Phase 0)

| # | Question | Why it matters | How to settle it |
| --- | --- | --- | --- |
| U-a | **Does skipping `/register` really deliver both `messages` and `smb_message_echoes` for a coexistence number?** M4 says skip; M5 Step 3 and M6 Step 4 list `/register` as a required onboarding step. | If M4's "skip" is wrong, every coexistence deployment is silently dead on inbound — the exact failure mode `docs/whatsapp-architecture.md` records as the reason `/register` exists. | Onboard a real test business via coexistence without `/register`, send from the app, and confirm an echo arrives. Then confirm inbound still works. Cheap and decisive. |
| U-b | Does a BISU token have permission to fetch **media ids that originated from the WhatsApp Business app** (echo and history media)? | If not, every echo/history attachment is lost and WACRM falls back to a permanently blank bubble. | Fetch one echo media id with the business token during the spike. |

### Meta documentation gaps or contradictions

| # | Uncertainty | Evidence | Design stance |
| --- | --- | --- | --- |
| U1 | **v2/v3 end-of-life.** The banner says "Embedded signup **v2** will be deprecated on October 15, 2026"; the Versions table says v2, v2-public-preview **and v3** are "Available Until: October, 2026". Does v3 die on 15 Oct too, or at the end of October? | M2/M3/M4/M5/M6 banner vs M3 table | Target **v4** from the start (`extras: {}`, Cloud API product in the login configuration). Treat v3 as a short bridge only. Make the extras shape a server-side setting, never a hardcoded constant. Add the v2 cut-off as a dated guard in `embedded-signup-extras.ts` |
| U2 | **Code TTL: 30 seconds or 60?** The implementation page says the exchangeable code "has a time-to-live of 30 seconds". The recommended login-configuration template is named "WhatsApp Embedded Signup Configuration With **60 Expiration Token**". | M2 vs M2 | Treat **30 s** as the documented value (it is the explicit prose). Design is unaffected because the exchange is inline; a 60 s code would simply be more forgiving. Record it. |
| U3 | **`/register` for coexistence** — see U-a. | M4 vs M5/M6 | Skip, as M4 states explicitly. Encapsulated in `shouldRegisterPhoneNumber` so it is a one-line change. |
| U4 | **Echo media shape.** The reference's `<MESSAGE_TYPE>` says contents "follow the send-messages payload shapes" (i.e. `id` + `mime_type` + `sha256`, no `url`), but the `edit` example's `image` object also carries a direct `url` on `lookaside.fbsbx.com`. | M10 | Prefer the `id` → `getMediaUrl` path (consistent with today's inbound code, and the only one that works with a `url` that may be short-lived). Fall back to an inline `url` if `id` is absent. Best-effort try/catch, as today. |
| U5 | **Live delivery status for mobile-originated messages.** No webhook field is documented for the delivery/read status of a message sent from the WhatsApp Business app. `history_context.status` is a backfill artifact, not a live feed. | absence in M9's field table and M10 | Assume none (§2.10). Echoes persist as `status='sent'` and are never regressed. If a status webhook does exist, `handleStatusUpdate`'s existing wamid match would pick it up for free. Needs a sandbox observation to confirm. |
| U6 | **Session-event asset ids for `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`.** The coexistence page's example shows `data: { waba_id }` only, plus `version: 3`; the generic implementation page shows `phone_number_id`, `waba_id`, `business_id` for other finish events. Does the coexistence event always carry the phone number id? | M4 vs M2 | **Never trust it.** The server derives `phone_number_id` from `GET /{waba_id}/phone_numbers` after the exchange, and reconciles the client-reported ids into a log line. A coexistence payload with only `waba_id` is a supported input shape, not an error. |
| U7 | **Do `smb_app_data`, `is_on_biz_app` and `platform_type` exist on Graph API v21.0?** WACRM pins `v21.0`; every coexistence example uses `v25.0`. | `meta-api.ts:14` vs M4 | Use a per-call version override (`v25.0`) for the coexistence-only endpoints and leave the global constant alone. Verify on the spike; if v21.0 works, the override becomes cosmetic. |
| U8 | **Is `message_echoes[].to` `+16505551234` or `16505551234`?** The reference's parameter table shows `+16505551234`; the example shows `16505551234`. | M10 | `normalizePhone` on every echo `to` and on every history `from`, so either form resolves. The asymmetry is almost certainly a docs typo, but the normaliser makes it irrelevant. |
| U9 | **When does the 24-hour sync window start?** M4 says "After you onboard the business customer, you have 24 hours". Onboarding completion, the last onboarding API call, or the `smb_app_data` request? | M4 | Record `history_sync_deadline_at = history_sync_requested_at + 24h` for the countdown, but treat "onboarding completed" as the true deadline. Issue both `smb_app_data` calls immediately (§4.1 step 5) so the distinction does not matter operationally. |
| U10 | **Are `history` webhooks retried for 7 days like other webhooks?** M9's general rule says any non-200 is retried for up to 7 days, which would mean a chunk can be redelivered after `progress: 100`. | M9 general rule vs M4's silence on retry for `history` | Assume yes. `UNIQUE (field, payload_digest)` plus the `messages` unique index make redelivery harmless, and `GREATEST` keeps progress monotonic. |
| U11 | **Can a number already registered on Cloud API be onboarded to coexistence?** Not documented. M1 says numbers "can only be registered for use with Cloud API"; M4's flow requires a number currently on the app; M4 blocks the Deregister API once coexisting. | M1, M4 | **No.** §4.4 documents the three options and recommends against attempting a conversion. Do not build a migration affordance. |
| U12 | **Missing "Step 2" in the coexistence app-setup instructions.** M4's "Setting up your app" has Step 1 (subscribe webhooks) and Step 3 (surface Embedded Signup) with no Step 2, yet M3 links to `#step-2--customize-embedded-signup` for the `feature_type` customisation. The customisation content is not on the page. | M4 vs M3 | Infer the content from M3's `extras` tables (v2/v3 `featureType`, v4 via the login configuration) and from M4's own statement that WhatsApp Business app user onboarding "continues to be supported through the `feature_type` parameter". The inference is low-risk because `extras` is a server-side setting. Worth re-checking the page before Phase 3. |
| U13 | **Which Meta error codes are specific to coexistence / revoked business tokens?** Not documented in the pages read. | — | `explainMetaError` degrades gracefully to a generic message with `code`/`subcode`/`fbtrace_id` preserved, so nothing breaks. Add explicit branches only after a real code is observed. Do not guess codes. |
| U14 | **How does Meta signal the 20 mps coexistence cap?** `isRecipientNotAllowedError` in `phone-utils.ts` handles only "recipient not allowed". Throughput errors (`131xxx`) are undocumented for this case. | M4 vs `phone-utils.ts` | Out of scope for this change. Do not add speculative backoff. Note it as a known gap for the broadcast engine. |
| U15 | **`contacts[].identity_key_hash`** appears in the unsupported-messages payload "only if identity change check enabled". Coexistence does not require it. | M12 | Add to `WaContactPayload` as optional and ignore. |
| U16 | **`smb_app_data` API reference 404s** at the URL M4 links to
  (`developers.facebook.com/docs/graph-api/reference/whats-app-business-account-to-number-current-status/smb_app_data`). The request/response shape in M4 is therefore the only available specification. | M4 link is dead | Implement to M4's documented shape. If the real reference surfaces later, re-verify the field names before Phase 3. |

### Open product decisions (need a human, not a doc)

| # | Decision | Recommendation |
| --- | --- | --- |
| P1 | Do history-synced threads create inbox-visible conversations? | Create conversations but `status='closed'` + `source='history_sync'`, gated behind a default-off `show_imported_history` setting (§7.6). Importing 180 days unfiltered is unusable; creating nothing reads as data loss. |
| P2 | Skip or persist `media_placeholder` history rows? | **Skip** (§7.5). A known bounded gap beats an exception to the idempotency boundary. |
| P3 | `PLAYED` history status maps to `delivered`? | Yes — no `played` value exists in the CHECK and one voice-note state is not worth widening a constraint. Flagged as an information loss. |
| P4 | What happens on `smb_app_state_sync` `remove`? | Log only, never delete (§7.7). Destructive contact sync is a separate project. |
| P5 | Should echoes emit a public webhook event (`message.sent_by_business_app`)? | Not in Phase 3. It is a public-API surface change and `docs/public-api.md` would need updating. Add in a later phase if operators ask. |
| P6 | How much pre-flight disclosure before the business commits to coexistence? | The full §9.4 list. Irreversible user-visible effects (disappearing messages disabled, broadcast lists read-only, devices unlinked) are the business's informed choice, not a footnote. |
| P7 | Should coexistence be available at all to a fork that is a direct developer? | No. The card is disabled with the partner-status reason (§9.2). Do not let an operator discover this only after completing a half-flow. |

---

## 16. Implementation phases

Ordered by dependency and by blast radius. **Nothing below is
implemented in this task.**

### Phase 0 — Spike (no code shipped; ~1 day)

Validate against a real Tech-Provider test business, in a scratch
branch or even curl, with **no** WACRM code:

1. Configure the app per §14 (Business type, FB Login for Business, v4
   login configuration, the three coexistence fields + `account_update`).
2. Complete Embedded Signup with `feature_type:
   whatsapp_business_app_onboarding`.
3. Exchange the code; **skip `/register`**.
4. `POST /{waba_id}/subscribed_apps`.
5. `GET /{phone_number_id}?fields=is_on_biz_app,platform_type`.
6. Send a message from the **Cloud API**; confirm the `messages` webhook
   and the status webhooks arrive → resolves **U-a**, **U5**, **U7**.
7. Send a message from the **WhatsApp Business app**; confirm an
   `smb_message_echoes` webhook with the documented shape, and record
   the exact `to` format and whether a media `url` is present → resolves
   **U4**, **U8**.
8. Message the number from a personal WhatsApp for the **first time**;
   capture the `131060` payload → confirms §7.9.
9. `POST smb_app_data` with both `sync_type` values; capture a `history`
   chunk, its `chunk_order`/`progress` values, whether a
   `media_placeholder` is followed by a media webhook, and the `to`
   format → resolves **P2**, **U10**.
10. Try `getMediaUrl` on an **echo** media id with the business token →
    resolves **U-b**.
11. Disconnect from the app; capture the `account_update` payload →
    confirms §7.8.
12. Test **v4 vs v3** `extras` shapes and record which the flow actually
    used → resolves **U1**, **U12**.

**Exit criterion:** U-a, U-b, U4, U7, U8 are answered from observation.
If U-a comes back "you do need `/register`", the design changes in one
place (`shouldRegisterPhoneNumber`) and the metadata columns gain a real
`registration_mode` value — no schema redesign.

### Phase 1 — Schema only (migrations 043–046)

Deliver migrations, `verify-schema.sql` assertions, the
`redeem_whatsapp_onboarding_session` RPC, and the
`whatsapp_webhook_queue` table. **No application code changes**, so this
is deployable and revertible independently.

*Exit:* `supabase db reset --local --no-seed` +
`supabase db query --local --file supabase/ci/verify-schema.sql` green;
every pre-existing row shows `api_only` / `system_user`.

### Phase 2 — Read-only coexistence status (no mutation)

`GET /api/whatsapp/onboarding/state`, the `coexistence-mode`,
`coexistence-probe`, `account-update`, `app-secret-for-id` and
`embedded-signup-extras` pure modules, and the mode selector + disabled
card in the UI. Additive response fields on `GET /api/whatsapp/config`.

*Exit:* coexistence is visibly "not configured" with a precise reason;
nothing existing changed; full pre-flight green.

### Phase 3 — Onboarding (Embedded Signup → live number)

`meta-api.ts` new helpers, the onboarding routes, the
`whatsapp-config.tsx` coexistence panel with the ES launch, the
pre-flight disclosure, and the state-machine checklist. Tokens
persisted before `subscribed_apps`; `/register` skipped for coexistence;
`POST /api/whatsapp/config` refuses to clobber a coexistence row.

*Exit:* a coexistence number receives `messages` and `statuses`; a
sandbox account can complete the flow end-to-end; no token value ever
appears in a response body or a log.

### Phase 4 — Echoes and account lifecycle

`smb_message_echoes` ingestion and processing, `edit` / `revoke` on both
fields, `account_update` handling, the `131060` short-circuit, and the
inbox `source` / `deleted_at` presentation.

*Exit:* an agent message sent from the WhatsApp Business app appears in
the right thread with no unread bump, no automation, and no AI reply;
disconnect banners work; 7-day webhook redelivery of an echo is a no-op.

### Phase 5 — Contacts and history sync

`smb_app_state_sync`, the `whatsapp_webhook_queue` drain endpoint
(+ `docs/docker.md` scheduler note), `history` ingestion, the progress
UI with the 24-hour countdown, the sync state guards, and the
`show_imported_history` setting. **This is the most expensive phase** —
queue, drain worker, bulk-insert paths, and product decisions P1/P2 are
all here, which is why it is separate from Phase 4.

*Exit:* a full history sync lands with correct direction, ordering,
status mapping, and no side effects; a declined sync is reported as
information; a redelivered chunk changes nothing.

### Phase 6 — Hardening and optional depth

`/debug_token` probe (redacted) and `token_last_verified_at`; BISU
token rotation via `/{client_business_id}/system_user_access_tokens`
with `appsecret_proof`; the narrowly-scoped status-UPDATE fix (limitation
#13 in `whatsapp-architecture.md`); `P5` public webhook for echoes;
`account_alerts` / `phone_number_quality_update` health surfacing; and
the `waba_id`-to-config normalisation note.

### Explicitly deferred

Multi-number-per-account, contact merging for the BSUID/phone gap
(§8.1), 20 mps throughput backoff (U14), granular per-client tokens,
Conversions API for business messaging, `profiles.role` cleanup, the
001-era `"Service role can insert messages"` policy review, `ENCRYPTION_KEY`
rotation, and `middleware.ts` → `proxy.ts`.

---

## 17. Phase 0 validation results

**Scope of this section.** Phase 0 was executed as an evidence-gathering
task. **No application code, migration, or configuration was changed.**
Everything below is either (a) a re-read of official Meta documentation
retrieved on **2026-09-30**, or (b) a statement that sandbox observation was
not possible, with the exact reason.

**Source-index correction.** Every URL in the M1–M14 index above now
returns `404`. Meta moved WhatsApp Business Platform documentation to
`https://developers.facebook.com/documentation/business-messaging/whatsapp/…`.
The M-numbers are retained for continuity; §17.1 maps each to its current
canonical URL. Several claims below also carry *content* drift, not just a
moved URL, and those are called out individually.

### 17.1 Phase 0 sources

| # | Page (canonical, 2026-09-30) | Replaces |
| --- | --- | --- |
| P1 | `…/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users` | M4, M14 |
| P2 | `…/documentation/business-messaging/whatsapp/embedded-signup/implementation` | M2 |
| P3 | `…/documentation/business-messaging/whatsapp/embedded-signup/versions` | M3 |
| P4 | `…/documentation/business-messaging/whatsapp/embedded-signup/version-4` | M3 |
| P5 | `…/documentation/business-messaging/whatsapp/embedded-signup/overview` | M1 |
| P6 | `…/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider` | M5 |
| P7 | `…/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-solution-partner` | M6 |
| P8 | `…/documentation/business-messaging/whatsapp/access-tokens` | M7 |
| P9 | `…/documentation/facebook-login/facebook-login-for-business` | M8 |
| P10 | `…/documentation/business-messaging/whatsapp/webhooks/overview` | M9 |
| P11 | `…/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes` | M10 |
| P12 | `…/documentation/business-messaging/whatsapp/webhooks/reference/history` | M14 |
| P13 | `…/documentation/business-messaging/whatsapp/webhooks/reference/account_update` | M11 |
| P14 | `…/documentation/business-messaging/whatsapp/webhooks/reference/messages/unsupported` | M12 |
| P15 | `…/documentation/business-messaging/whatsapp/webhooks/reference/messages/status` | new |
| P16 | `…/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/register-api` | M13 |
| P17 | `…/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers` | new |
| P18 | `developers.facebook.com/blog/post/2026/07/29/introducing-graph-api-v26-and-marketing-api-v26` | new |

### 17.2 Sandbox execution: not possible

No sandbox observation was performed. Three independent blockers apply;
the first two are environmental, the third is a Meta product limitation
that no amount of credentials removes.

| # | Blocker | Exact evidence |
| --- | --- | --- |
| B1 | **No Meta App ID.** `META_APP_ID` is unset in `.env.local` and is commented out in `.env.local.example` (line 104). Without it `appsecret_proof` cannot be computed (`sha256(token + secret)` needs both), and Embedded Signup cannot be launched — `FB.init({ appId })` is mandatory. | `src/lib/whatsapp/meta-api.ts:14`, `.env.local.example:104` |
| B2 | **No login configuration, no partner status.** `META_EMBEDDED_SIGNUP_CONFIG_ID` does not exist anywhere in the repository (zero hits). Coexistence additionally requires Solution Partner or Tech Provider status, which requires Meta business verification, App Review, advanced access for `whatsapp_business_messaging` + `whatsapp_business_management`, and video evidence of a working send/receive integration (P17). No such app, portfolio or approval is reachable from this environment. | P1 "Requirements", P17 "Step 1"/"Step 2" |
| B3 | **Meta's sandbox account cannot send or receive messages.** P5 "Sandbox account limitations": *"You can exchange the returned token code for the sandbox account's business token and use it to get data on the account's WABA ID, but **the business phone number cannot be used to send or receive messages**."* Therefore tests **C, D, E, F** and the messaging half of **A/B** are **structurally impossible** in a sandbox account, independent of B1/B2. | P5 |

The only Meta credential present is `META_APP_SECRET` (set, 32 chars), which
is inert without an app id. The only WhatsApp credentials this deployment
could reach are production `whatsapp_config` rows, which are out of scope
for experimentation by the Phase 0 brief. **No Meta API call was made.
No token, code or secret was read, exchanged, printed or recorded.**

**Consequence:** every item below is `DOCUMENTED ONLY`, `CONFIRMED`,
`STILL UNCERTAIN` or `BLOCKED`. **Nothing is `OBSERVED`.** The exit
criterion in §16 Phase 0 ("U-a, U-b, U4, U7, U8 answered from observation")
was **not met** and cannot be met without an operator-supplied Tech
Provider test business.

**Cheapest unblocking path (no code required):** the *Embedded Signup
Integration Helper* (App Dashboard → WhatsApp → **Embedded Signup Builder**,
Business-type apps only, P5) launches the flow in several configurations,
shows exactly what a completing business customer returns, generates the
onboarding queries, and can run them. It can settle **A**, **B**, **U6**,
**U1**, **U12** and the `/register` question (U-a) on a **real Tech Provider
test business** without a single line of WACRM code. Tests C–F still need a
physical WhatsApp Business app on a real number and a second real WhatsApp
account to exchange messages with.

### 17.3 Results by uncertainty

| ID | Subject | Class | Conclusion in one line |
| --- | --- | --- | --- |
| U1 | v2/v3 end-of-life | **CONFIRMED** | v2 **and v3** (and both public previews) die **2026-10-15**; there is no v3 bridge. |
| U2 | Code TTL 30 s vs 60 | **CONFIRMED** (contradiction persists) | 30 s is the explicit prose; the "60 Expiration Token" template name is still a docs artefact. |
| U3 / U-a | `/register` for coexistence | **BLOCKED** | Docs still contradict each other (P1 "skip" vs P6 Step 3 / P7 Step 4 "register"). Unresolvable without a real test business. |
| U4 | Echo media shape | **CONFIRMED** (inconsistency real) | Contents follow *send-messages* shapes (no `url`), but the echo `edit` example carries both `id` and a `lookaside.fbsbx.com/...` `url`. |
| U5 | Live status for app-sent messages | **STILL UNCERTAIN** | No coexistence status field exists; `messages.statuses` triggers are worded generically and never scoped to API-originated sends. |
| U6 | Session-event asset ids | **CONFIRMED** | The coexistence finish event carries **`waba_id` only** — no `phone_number_id`. Deriving it server-side is mandatory, not defensive. |
| U7 | Do coexistence fields exist on v21.0? | **BLOCKED** | Undocumented. Only ever shown at v25.0. Compounded by a hard v21.0 removal date — see §17.4.10. |
| U8 | Echo `to` format | **STILL UNCERTAIN** (contradiction confirmed) | Reference parameter table says `+16505551234`; **every** worked example says `16505551234`. `normalizePhone` is required, not cosmetic. |
| U9 | When the 24 h sync window starts | **STILL UNCERTAIN** | "After you onboard the business customer" — onboarding completion. Design's immediate-issue stance neutralises it. |
| U10 | Are `history` webhooks retried? | **DOCUMENTED ONLY** | The 7-day retry rule is general to all webhooks (P10); the `history` reference is silent. Assume yes. |
| U11 | Cloud-API-only number → coexistence | **CONFIRMED** (undocumented path absent) | No documented conversion path; Deregister API is explicitly blocked in coexistence (P1). |
| U12 | Missing "Step 2" | **STILL UNCERTAIN** | P1 still jumps Step 1 → Step 3; P4 still links to the dead `#step-2--customize-embedded-signup` anchor. |
| U13 | Coexistence-specific error codes | **BLOCKED** | Only `131051`/`131060` (P14) and `2593109` (P12) are documented. Do not guess. |
| U14 | 20 mps signalling | **STILL UNCERTAIN** | Undocumented. Out of scope, unchanged. |
| U15 | `contacts[].identity_key_hash` | **CONFIRMED** | Present on the `messages` webhook (P14) and on `statuses` (P15), only when identity-change check is enabled. |
| U16 | `smb_app_data` reference 404s | **CONFIRMED** (still dead) | The URL Meta links from P1 still returns 404. P1 remains the only specification. |
| U-b | BISU token can fetch app-originated media | **BLOCKED** | Needs a real send. Unchanged as a Phase 4 gate. |
| P2 | Skip `media_placeholder`? | **CONFIRMED** | The enrichment webhook **reuses the same wamid**, so skipping is provably safe and needs no exception to the idempotency boundary. |
| P3 | `PLAYED` → `delivered` | **CONFIRMED** (unchanged) | `PLAYED` appears in both `history_context.status` and the live `statuses` vocabulary; neither exists in the schema CHECK. |
| P7 | Coexistence for a direct developer | **CONFIRMED** | No supported path. Disabled card with a partner-status reason remains correct. |

### 17.4 Detailed findings

#### 17.4.1 Eligibility — CONFIRMED

- P1 "Requirements": *"You must already be a **Solution Partner** or
  **Tech Provider**."* Unchanged from M4.
- P8 confirms the split: *"If you are a **direct developer**, meaning only
  you or your business will be accessing your own data, use a **System User
  access token**."* There is **no** Embedded Signup — and therefore no
  coexistence — path for a direct developer. P8's comparison table marks
  business integration system user tokens **"Tech Providers only"**.
- P17 documents the actual gate: Meta **business verification** → **App
  Review** → advanced access for `whatsapp_business_messaging` *and*
  `whatsapp_business_management` (P17 states that without the latter, API
  calls on client WABAs "return error code `200`").
- P17 adds a prerequisite the design did not capture: App Review requires
  **video evidence** that the app can send a message received in the
  WhatsApp client and can create a template. In other words a fork must
  already work as an `api_only` integration *before* coexistence is
  reachable. This reinforces §2.1 and does not weaken the `api_only` path.
- P17 also documents a route the design omits: a direct developer can obtain
  Tech Provider status via **"Onboard with an existing Solution Partner"**
  by entering the partner's app id (a Multi-Partner Solution), or
  **"Onboard without a partner"**. Worth putting in §14.1 as the concrete
  path an operator follows.
- Partner-tier naming drift: P6 is now titled "as a **Tech Provider or Tech
  Partner**", and P5's billing section has a "Tech Providers and Tech
  Partners" heading. Update §14.1 wording; no behaviour change.
- **No coexistence-specific sandbox exists.** P5's sandbox section is
  Embedded-Signup-only. §13.7's premise — that a sandbox account can
  validate coexistence — is wrong (see §17.6).

**Design impact:** §2.1, §3.1, §9.2 and P7 stand unchanged and are now
better sourced. §13.7 and §14.1 must change (see §17.5).

#### 17.4.2 Embedded Signup — mostly CONFIRMED, two changes required

- **Session logging and `account_update` are mandatory.** P2 "Before you
  start": *"You must be subscribed to the `account_update` webhook, as this
  webhook is triggered whenever a customer successfully completes the
  Embedded Signup flow, and contains their business information."* This
  strengthens §2.8 — `account_update` is not just "required for Embedded
  Signup generally", it carries the onboarding-completion signal.
- **v4 is current and `whatsapp_business_app_onboarding` is a v4 feature
  type.** P3's feature-availability table lists, for `v4`, feature type
  `whatsapp_business_app_onboarding`. P4: *"WhatsApp Business app user
  onboarding continues to be supported through the `feature_type`
  parameter."* So the design's `extras` handling is right in substance.
- **U1 resolved — and it invalidates the v3 bridge.** P3's banner and
  Meta's official v4 announcement both state *"Embedded signup v2 **and v3**
  will be deprecated on **October 15, 2026**, including their public
  preview versions."* P3's table agrees that v2, v2-public-preview,
  v3 and v3-public-preview are all "Available Until: October, 2026".
  §15 U1 and §16 treat v3 as a usable short bridge; **it is not** — it dies
  on the same day as v2. *Caveat:* two Meta pages (P5 overview, P4) currently
  render a banner saying "October **8**, 2026". The versions page, the
  coexistence page and the dated blog post all say October 15. Plan to
  October 15; treat the "8" banner as a docs typo, but re-check before
  committing code.
- **`extras` shape differs per version — including within v4.** P3:
  - stable **v4** ⇒ `extras: {}` — *"The extras object is purposely empty for v4."*
  - **v4-public-preview** (2026-05-12) ⇒ `extras: { version: "v4-public-preview" }` — **not** empty.
  - v3 ⇒ `{ setup, features, featureType, version }`.
  - v2 ⇒ `{ setup, features, featureType, sessionInfoVersion }`.
  P2's reference implementation (now written for v4) shows
  `extras: { setup: {} }`. So "extras is empty for v4" is true of the
  stable version but the shape is version-dependent in three ways.
  `embedded-signup-extras.ts` must treat it as a four-way switch, and the
  dated guard must reject **v2, v2-public-preview, v3 and v3-public-preview**
  from 2026-10-15, not v2 alone.
- **U6 confirmed.** P1: the coexistence finish event is
  `{ data: { waba_id }, type: "WA_EMBEDDED_SIGNUP", event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", version: 3 }`.
  P2's *generic* success payload carries `phone_number_id`, `waba_id`,
  `business_id` plus optional `ad_account_ids`, `page_ids`, `dataset_ids`,
  `catalog_ids`, `instagram_account_ids` and `waba_ids` (multi-WABA). The
  asymmetry is documented, so the design's "re-derive from Meta, never trust
  the client" stance is *required for correctness*, not merely prudent.
  Two new finish values to handle: `FINISH_GRANT_ONLY_API_ACCESS`, `ERROR`.
- **P2 confirms two behaviours the design inferred:**
  *"On the final screen, both clicking **Finish** and closing the popup
  (for example, by clicking the X button) are considered successful
  onboarding… Exiting on the final screen is not considered a cancel
  event."* → the client must treat a popup-close-after-finish as success,
  not as E3 `CANCEL`. Also `event.origin.endsWith('facebook.com')` is
  Meta's own reference check (§9.6 matches).
- **U12 still open, but bounded.** P1 still has Step 1 then Step 3; P4
  still deep-links to `#step-2--customize-embedded-signup`, which does not
  exist. The *mechanism* is documented (P3 + P4 `feature_type`), only the
  customisation instructions are missing. Keep `extras` a server-side
  setting; downgrade U12 from "worth re-checking before Phase 3" to
  "not load-bearing".
- **New, operationally useful:**
  - **Webhook overrides** (P5, P10, P6 Step 2) allow a per-WABA or
    per-phone callback URL. This is the isolation mechanism any Phase 0
    test should use so a test WABA cannot disturb production webhooks.
  - The **Embedded Signup Integration Helper** (P5) — see §17.2.
  - **555 business phone numbers** (P5): two per business customer, `+1`
    555, automatically verified, display name must be approved. Not a
    coexistence/app number, so it cannot substitute for a real business, but
    it removes the SIM requirement for pure Cloud API message-flow testing.
  - Business customers must add their own payment method unless the operator
    is a Solution Partner with a shared credit line (P5, P6 Step 5) —
    §14.8 already says this.

#### 17.4.3 Token flow — CONFIRMED, with drift in the source

- Exchange is `GET /oauth/access_token?client_id&client_secret&code`,
  server-to-server only, producing a **business integration system user
  access token** (P6 Step 1, P7 Step 1, P5 "Access tokens"). P6/P7's curl
  uses `v21.0`; P9 uses `v25.0`. The exchange endpoint is therefore not
  version-sensitive in practice — do not treat the version in these docs as
  normative.
- **Code TTL 30 seconds is the authoritative prose** (P2, explicit
  *Warning*). The contradiction is unchanged: P2 Step 2 still recommends the
  *"WhatsApp Embedded Signup Configuration With **60 Expiration Token**"*
  template. Design's inline, unqueued exchange is validated; the code is
  never persisted.
- **BISU expiry semantics confirmed on P9**, not P8. The comparison table
  states: *"Expiration and refresh — Defaults to **never expire** for the
  common offline server-to-server communication."* Note the drift: **P8 no
  longer contains the expiry/refresh detail at all** and now merely points at
  P9. Any future citation of M7/P8 for "never expires" is wrong; cite P9.
- **No refresh flow**, unchanged. Invalidation is client-side: Business
  Manager → Settings → Business Settings → Integrations → Connected apps →
  remove the app, which P13 documents as `PARTNER_APP_UNINSTALLED`.
- **BISU management API confirmed exactly as designed** (P9): `appsecret_proof`
  is **Required**, the calling token needs `business_management`, and
  `asset` / `scope` / `fetch_only` / `set_token_expires_in_60_days` are all
  supported. Granular per-client-business tokens are supported and
  recommended for blast-radius isolation.
- **New BISU requirements the design should record:**
  - The business customer must have, or be willing to create, a **business
    portfolio**; the operator's app must be associated with a **different**
    portfolio the operator fully controls.
  - *"Your app can only request logins from web surfaces"*, and P9's
    troubleshooting lists *"Business System User Access Token is not
    currently supported on Mobile devices"*. WACRM's design is web-only, so
    this is compatible — but it rules out onboarding from a native mobile
    app and should be stated in §14.
  - `email` and `public_profile` are auto-granted but at least one other
    supported permission must be requested (P9).

#### 17.4.4 `/register` — BLOCKED (docs still contradict)

The contradiction is **still live in current official documentation**:

| Source | Says |
| --- | --- |
| P1 (coexistence) | *"onboard the customer as you normally would, but **skip the phone number registration step**, as the number is already registered."* |
| P6 (Tech Provider) | **Step 3: "Register the customer's phone number"** — `POST /{id}/register` with a 6-digit PIN. |
| P7 (Solution Partner) | **Step 4: "Register the customer's phone number"** — identical. |
| P5 (overview) | Lists *"register the customer's business phone number for Cloud API use"* as one of the four server-to-server calls after Embedded Signup, with no coexistence carve-out. |
| P16 (Register API reference) | **Silent** on coexistence. States only that `/register` *"performs two actions at the same time"* (register + enable 2FA), that *"Setting up two-factor authentication is a requirement to use the Cloud API"*, and that an Embedded Signup phone number *"must be registered within 14 days"*. |

So: **required / optional / prohibited is undocumented.** P1's "skip" is
the only coexistence-specific statement, and it is explicit; the generic
partner pages are not coexistence-aware. Nothing observed (B1–B3).

**Additional operational facts from P16 that the design should carry:**

- `/register` also sets the 2FA PIN. A coexistence number's 2FA is already
  configured by the business in the WhatsApp Business app, which is
  internally consistent with P1's "the number is already registered".
  WACRM must therefore never treat a coexistence row's missing PIN as an
  error, and must never offer to "verify registration" by calling
  `/register`.
- The 14-day Embedded Signup registration window applies to the generic
  path. It is unclear whether it also binds coexistence numbers; if it does,
  a coexistence number that is never `/register`ed would eventually be
  forced back through Embedded Signup. **Undocumented** — add to the Phase 0
  checklist.

**Design impact:** §2.6 and `shouldRegisterPhoneNumber` are unchanged and
remain the correct reading, with the flip cost exactly as §16 states. But
the exit criterion for U-a cannot be met here, and it is the single
highest-risk open item (see §17.7).

#### 17.4.5 `subscribed_apps` — CONFIRMED

- `POST /{WABA_ID}/subscribed_apps` with the **business token**, returning
  `{"success": true}`, is Step 2 of both partner flows (P6, P7). P1 makes it
  a coexistence prerequisite: *"make sure that you subscribed the business's
  WABA when you onboarded the business, and that you are subscribed to the
  additional webhook fields, otherwise you will miss important webhooks."*
- **Permissions are split** (P10): `whatsapp_business_messaging` for
  `messages`; `whatsapp_business_management` for **all other** fields —
  which includes `history`, `smb_message_echoes`, `smb_app_state_sync` and
  `account_update`. WACRM's coexistence fields therefore depend on
  `whatsapp_business_management`, which §1.2 currently treats as
  "optional in practice". For coexistence it is **required**.
- Partners need **advanced access via App Review** for both permissions or
  business customers cannot grant them (P10, P9, P5).
- Payload ceiling **3 MB** and retry "with decreasing frequency … for up to
  **7 days**", and *"Meta sends retries to all apps that have subscribed to
  webhooks … These retries can result in duplicate webhook notifications"* —
  duplicate delivery is explicitly expected, which strengthens §5.3's
  `UNIQUE (field, payload_digest)` reasoning beyond "assume yes".
- App must be **Live**; some webhooks are not sent in Dev mode (P10).
- Webhook **overrides** are supported per WABA and per phone number (P5,
  P10) — use them to isolate a test number.
- **Field-list drift.** P10's documented field table has grown since M9 and
  now also includes `security`, `user_preferences`, `business_capability_update`,
  `automatic_events`, `template_category_update`, `account_review_update`,
  `partner_solutions`, `payment_configuration_update`. None is required for
  coexistence. §14.6 should be worded "subscribe to at least these", not
  as an exhaustive list. (`security` is worth a Phase 6 look: it reports
  changes to a business phone number's security settings, which for a
  coexistence number includes the app-side security posture.)

**Design impact:** §2.7 stands unchanged. `whatsapp_business_management`
should be promoted from "optional" to "required for coexistence" in §1.2/§14.

#### 17.4.6 `smb_message_echoes` — CONFIRMED, with one new identity finding

Confirmed from P11 (the dedicated reference) and P1:

- Field `smb_message_echoes`, key **`message_echoes[]`**, envelope
  `object: "whatsapp_business_account"`, `entry[].id` = **WABA id**,
  `metadata.display_phone_number` + `metadata.phone_number_id`.
- **No `contacts[]` array, no BSUID, no profile name.** The customer appears
  only as `to`. §8.1 confirmed.
- `from` = business display phone number; `to` = WhatsApp user;
  `id` = wamid; `timestamp` = **webhook trigger timestamp** (P11) — note the
  contrast with `history`, where `timestamp` is documented as a
  **device** timestamp. Different semantics; §7.2/§7.4 should say so.
- Documented types: **`text`, `image`, `video`, `document`, `revoke`,
  `edit`** — exactly as the design claims. P11's trigger list now explicitly
  includes the business revoking and editing a previously sent message, and
  both have worked examples on the echoes field.
- **U4 confirmed as a genuine inconsistency.** `<MESSAGE_CONTENTS>` says to
  read *Sending messages* for the payload shapes (which carry `id`,
  `mime_type`, `sha256` and **no** `url`), yet the echo `edit` example's
  `image` object carries **both** `id` and a
  `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=…` `url`.
  Design's rule — prefer `id` → `getMediaUrl`, fall back to an inline `url`
  only when `id` is absent, best-effort try/catch — is validated.

New findings not in the design:

1. **Echo `to` is not a canonical WhatsApp identity.** P11: *"This is the
   same value returned by the API as the `input` value when sending a message
   to a WhatsApp user. Note that a WhatsApp user's phone number and ID may
   not always match."* So the echo's `to` is **the number the business
   dialled**. It may not equal `contacts[].wa_id` on a later inbound
   `messages` delivery for the same person. §8.1's "identity gap" is
   therefore **wider than BSUID-vs-phone**: it can also bite
   phone-to-phone. Consequences:
   - never present an echo-derived phone as a verified identity;
   - when an echo creates a contact, record that the key came from a dialled
     number, and let the normal `findExistingContact` phone match absorb a
     later inbound as today;
   - do **not** add fuzzy/heuristic merging (the design already says this).
2. **`edit` and `revoke` each carry their own new wamid** in `id`, plus
   `original_message_id`. If WACRM inserted the event itself it would render
   a duplicate bubble. The design's UPDATE-only handling is correct; make
   the "do not insert" rule explicit and add a test.
3. **Echoes can be addressed to another business**, not only a person (P11
   trigger: *"to a WhatsApp user or another business"*). B2B messaging:
   contact resolution may meet a business number. No special handling
   required, but worth a code comment.
4. **`U8` contradiction re-confirmed on the live page**: P11's parameter
   table shows `<WHATSAPP_USER_PHONE_NUMBER>` = `+16505551234`, while P11's
   own echo/revoke/edit examples, P1's example, and the `history` /
   `smb_app_state_sync` tables all use `16505551234`. `normalizePhone` is
   mandatory (not defensive) for every echo `to` **and** every history
   `from`.
5. No live status field is documented for echoes — see §17.4.8.

#### 17.4.7 History synchronization — CONFIRMED, plus one design gap

- **Available.** Trigger: `POST /{phone_number_id}/smb_app_data` with
  `{"messaging_product":"whatsapp","sync_type":"history"}`, response
  `{"messaging_product":"whatsapp","request_id":"…"}`. `sync_type:
  "smb_app_state_sync"` is the contacts equivalent. Both use `<API_VERSION>`
  and the **business token**. Both are **one-shot**: *"You can only perform
  this step once. If you need to perform it again, the customer must first
  offboard, then complete the Embedded Signup flow again."* Store
  `request_id` for support — confirmed.
- **24-hour window** from P1, for *both* contacts and history. U9 stands:
  "after you onboard the business customer". Design's "issue both calls
  immediately" neutralises the ambiguity.
- **180 days**, group chats excluded, three phases (day 0–1 / 1–90 /
  90–180, day 0 = onboarding onto Cloud API), chunks may arrive out of
  order via `chunk_order`, `phase` 2 = that phase complete, `progress` 100 =
  overall complete, **no webhooks at all for an empty phase**, and *"a single
  webhook could potentially describe thousands of messages. Capture the
  webhook contents first, then process them asynchronously."* All confirmed.
- `history_context.status` ∈ `DELIVERED, ERROR, PENDING, PLAYED, READ, SENT`
  — confirmed, P12. `PENDING`/`PLAYED` are outside the WACRM CHECK, so §7.4's
  mapping and P3 stand.
- Declined ⇒ `history[]` entry with `errors[0].code 2593109`, **no**
  `metadata` — confirmed exactly, including the `title`/`message`/
  `error_data.details` strings.
- `from` may be the business number **or** the user's number; `to` is
  *"only included if the message object represents an SMB message echo"* —
  confirmed, so §7.4's direction-from-`from` rule and its
  "the upsert absorbs an echo already seen live" reasoning are both
  documented.
- **`U16` re-confirmed dead**: P1 links the `smb_app_data` reference at
  `developers.facebook.com/docs/graph-api/reference/whats-app-business-account-to-number-current-status/smb_app_data`,
  which still returns **404**. P1 remains the only specification.
- **U10**: P10's 7-day retry rule is stated for webhooks generally; P12 is
  silent for `history`. Treat as general and keep the queue digest plus
  monotonic `GREATEST` progress.

**New — this is a genuine gap in §7.4 and it changes P2 for the better:**

> The **media-asset follow-up webhook is delivered on `field: "history"`,
> but its payload uses `value.messages[]`, not `value.history[]`, and
> carries no `history_context`.**

Meta's own example (P1 "Example payload for media message asset", mirrored
in P12) is `{"value": {"messaging_product", "metadata", "messages":[{…
"id": "wamid.QyNUEHBgL…", "type":"image", "image":{ "caption", "mime_type",
"sha256", "id" }}]}, "field": "history"}`. Note also that this media object
carries **no `url`** — media must be fetched by `id`.

Design consequences:

1. **The history handler must accept a `messages[]`-shaped change on the
   `history` field.** It must not require `value.history` to be present and
   must not route on the presence of `value.messages`. §7.1's dispatch table
   routes by `change.field`, which is correct, but §7.4 is written as
   *"Per `history[]` entry"* only and would drop every media enrichment
   delivery. Add a branch and a test.
2. **P2 is now decided by documentation.** In Meta's examples the
   `media_placeholder` and its later media asset carry the **same wamid**
   (`wamid.QyNUEHBgL…` in both). Therefore: skip the placeholder, and the
   follow-up webhook becomes the first — and only — insert through the
   existing `(conversation_id, message_id)` `ignoreDuplicates: true` path.
   Policy A is **CONFIRMED** and requires **no** exception to the idempotency
   boundary, which was the whole point of the recommendation.
3. `history_sync_phase` / `chunk_order` / `progress` come from
   `history[].metadata`. The media-enrichment delivery has **no** such
   metadata, so progress tracking must not assume it is present on every
   `history`-field delivery.

#### 17.4.8 Statuses for mobile-originated messages — STILL UNCERTAIN

- No coexistence-specific status field exists in P10's documented field
  list. There is no `smb_message_statuses` or equivalent.
- P15's triggers are worded generically — *"Your message is sent to a
  WhatsApp user"* / *"delivered"* / *"displayed (that is, 'read')"* /
  *"played"* / *"unable to be sent or delivered"* — and are **never scoped
  to API-originated messages**. P15 also states *"A status is considered read
  only if it has been delivered"*, and that a combined delivered+read case
  omits the `delivered` webhook.
- So the documentation neither confirms nor denies status delivery for a
  message sent from the WhatsApp Business app. Nothing observed.
- **Design impact: none required.** §2.10/§7.2's "`status='sent'`, never
  regressed" is correct under either answer, and §8.2's observation stands —
  WACRM's existing `handleStatusUpdate` matches by wamid and would adopt
  such statuses for free if they exist. Keep the assumption, keep it on the
  Phase 0 checklist.
- **New, relevant to P3:** P15's `<STATUS>` vocabulary now includes
  **`played`** alongside `sent, delivered, read, failed`. The live status
  vocabulary is therefore *broader* than the schema CHECK, exactly like
  `history_context.status`. `isValidStatusTransition` must tolerate an
  unknown incoming status without regressing the row.
- Also new in P15: from v24.0 the `conversation` object is **omitted
  entirely** unless the message was sent inside an open free-entry-point
  window (v23 and earlier returned a unique per-message id). `pricing.billable`
  is deprecated in favour of `pricing.type` + `pricing.category`. Neither is
  used by WACRM today; both become relevant if a global version bump to
  v24+ ever happens — which interacts with §17.4.10.

#### 17.4.9 Edit / revoke — CONFIRMED on both fields, with new windows

| Field | Who acts | Trigger window | Source |
| --- | --- | --- | --- |
| `smb_message_echoes` | business (app/companion) | not stated | P11 |
| `messages` | WhatsApp user | **edit: within 15 minutes** of sending | P1 "Edit" |
| `messages` | WhatsApp user | **revoke: within two days** of sending | P1 "Revoke" |

- Both are documented on **both** fields, with the payload shape the design
  assumes: `{ revoke: { original_message_id } }` and
  `{ edit: { original_message_id, message: { context: { id }, type, <type> } } }`.
- **New: the trigger windows.** An `edit` arriving more than 15 minutes
  late, or a `revoke` more than two days late, simply will not arrive.
  This does not change the handlers (both are `UPDATE`, hence idempotent
  and late-safe) but it does mean the inbox cannot promise "shows edits
  within 15 minutes of sending" and that a `revoke` reference to a wamid
  WACRM never saw is a normal, expected no-op — §12 E24 already models that.
- **New: the direction of a `revoke` reference.** The `messages`-field
  `revoke`/`edit` sections are documented as *"A WhatsApp user revokes
  (deletes) a previously sent message"* — i.e. the user revoking a
  **business-sent** message. Under coexistence that original may be held by
  WACRM as an **echo row** or as an **API-send row**, not as an inbound row.
  §7.3's "find the original by wamid within the resolved conversation" is
  therefore correct, but it must not assume `sender_type='customer'`.
- P1's feature-comparison table lists *"Message Edit/Revoke is now
  supported"* under 1:1 chats **after** onboarding — edit/revoke support is
  a consequence of coexistence onboarding, which is a good reason to pair it
  with the coexistence launch rather than treat it as a general capability.
- Echo-side `edit`/`revoke` carry their own new `id` (see §17.4.6 item 2).
  **Neither event may be inserted as a message row.** §7.3 implies this;
  state it explicitly and test it on both fields.

#### 17.4.10 API versions — CONFIRMED, and one finding changes the plan

Source: **P18**, Meta's official *Introducing Graph API v26.0 and Marketing
API v26.0* (2026-07-29), section "API Version Deprecations":

> - September 24, 2026: Graph API **v20.0** will be deprecated and removed.
> - **January 21, 2027: Graph API v21.0** will be deprecated and removed from
>   the platform.

- Current latest is **v26.0** (released 2026-07-29). v25.0 (2026-02-18) is
  no longer latest, although P2's reference still tells you to set the SDK
  version to *"the latest API version: **v25.0**"* — a stale instruction.
- **WACRM pins `v21.0` in two places**, not one:
  `src/lib/whatsapp/meta-api.ts:14` and
  `src/app/api/whatsapp/templates/sync/route.ts:25`. §15 U7 and §6.6 name
  only the first.
- **Coexistence-only surfaces are documented exclusively at v25.0**:
  `is_on_biz_app` + `platform_type` (P1), `smb_app_data` (P1),
  the BISU management API and `/me?fields=client_business_id` (P9).
  Meanwhile P6/P7 use **v21.0** for `/register` and `/messages`, and P2 uses
  `v25.0` for the token exchange. Meta's own pages are not version-
  consistent, which means **the docs cannot settle U7**.
- **U7 verdict: BLOCKED.** Whether `is_on_biz_app`, `platform_type` and
  `smb_app_data` exist on v21.0 is undocumented. Testing it requires a real
  coexistence number (B1–B3).
- **Design impact — the plan must change in substance, not just wording.**
  §6.6's *"leave `META_API_VERSION` alone"* is no longer a
  "smallest-correct-change" call, because v21.0 now has a **hard removal
  date of 2027-01-21** — roughly 3.5 months out. A coexistence feature that
  ships against a version with a fixed expiry would ship onto a cliff.
  Required changes:
  1. Make the v21.0 removal date an explicit, dated, tracked constraint
     (alongside the 2026-10-15 Embedded Signup date) rather than an
     incidental note.
  2. Do **not** hardcode `META_COEXISTENCE_API_VERSION = 'v25.0'` merely
     because it is what today's docs print. Pick the coexistence version
     with runway at implementation time and record the choice and its EOL.
  3. Note the second constant at `templates/sync/route.ts:25`; a
     "bump the global version" task must touch both, and `META_API_BASE` is
     derived from the constant, so a divergence is possible today.
  4. Keep the per-call `apiVersion` override mechanism — that part of §6.6
     is correct and is what makes (2) cheap.
  5. If a global bump to v24+ ever happens, re-check P15: the `conversation`
     object disappears from status webhooks and `pricing.billable` is
     deprecated.

#### 17.4.11 First-contact / `131060` — CONFIRMED, with the ambiguity isolated

- P1 "Errors" and P14 both document `131060` = *"This message is currently
  unavailable"*, **expected** in two situations: *"**First-time messaging**:
  A WhatsApp user messages your business for the first time"* (especially via
  ads that click to WhatsApp), and *"**Unsupported companion device**"*. P1
  adds: *"The error typically resolves within a few seconds, after which
  WhatsApp delivers messages normally."* And: *"If you receive this webhook,
  instruct the business to check the WhatsApp Business app for the message."*
- **The `messages` webhook for this case DOES include `contacts[]`** (P14
  syntax: `contacts[]` with `profile.name`, `wa_id`, and optional
  `identity_key_hash`). Therefore WACRM's existing guard
  `if (!value.messages || !value.contacts) continue` does **not** drop it,
  and today `processMessage` → `parseMessageContent` writes the literal
  string `[Unsupported message type: unsupported]` into the customer's
  thread. §7.9 is describing a **real, currently-shipping bug**, not a
  hypothetical.
- P14 restricts `errors[0].code` on this webhook to **`131051`** or
  **`131060`** only, and lists the matching titles (*"Message type
  unknown"* / *"This message is currently unavailable."*). So keying on the
  code — as §7.9 does — is correct and sufficient; there is no third code to
  handle on this path.
- **`unsupported.type` values (P14) are narrower than the design's list.**
  Documented: `button`, `edit`, `errors`, `gif`, `group_invite`, `hsm`,
  `image`, `interactive`, `keep_in_chat`, `link_preview`, `list`, `location`,
  `media_placeholder`, `order`, `pin`, `poll_creation`, `poll_update`,
  `product`, `reaction`. §2.12 item 4 lists `unsupported.type` values but
  omits `image`, `interactive`, `location`, `reaction`, `poll_creation` and
  `poll_update` — i.e. `unsupported` can wrap types that *are* otherwise
  supported. Behaviourally irrelevant (WACRM keys on the error code), but
  the list should be corrected so nobody later assumes `unsupported` implies
  "exotic".
- **Test E's actual question — does the real redelivery reuse the `131060`
  wamid or get a new one — is STILL UNCERTAIN and undocumented.** Meta says
  only that messages are "delivered normally" afterwards.
- **Design conclusion, and it is the useful one: the ambiguity does not
  block Phase 4.** Skipping the insert is correct under **both** semantics:
  - *same wamid* — inserting would permanently occupy
    `(conversation_id, message_id)` and the real message would be silently
    suppressed forever by the very idempotency boundary WACRM relies on;
  - *new wamid* — inserting would leave a contentless
    "unsupported" placeholder bubble in the customer thread.

  So test E downgrades from *blocking* to *confirmatory*. §7.9's
  no-insert / no-unread / no-automation / 200 behaviour stands unchanged and
  is now the robust choice rather than one branch of two.

#### 17.4.12 `account_update` — CONFIRMED

P13 confirms every event in §2.8's table and adds detail:

- `disconnection_info` is *"only included for `PARTNER_REMOVED` events when
  the business was using both the WhatsApp Business app and Cloud API"* —
  exactly the coexistence condition the design keys on. `reason` and
  `initiated_by` vocabularies confirmed verbatim (6 reasons, 2 initiators),
  including the inactivity windows (`COMPANION_INACTIVITY` ≈30 days,
  `PRIMARY_INACTIVITY` ≈14 days) — useful for §9.4's disclosure copy.
- `PARTNER_APP_UNINSTALLED` means *"a business customer deauthenticated or
  uninstalled the app"* → every stored token is dead. Design's
  `token_revoked_at` + re-run-Embedded-Signup guidance confirmed.
- `ACCOUNT_OFFBOARDED` / `ACCOUNT_RECONNECTED` are marked **New** and are
  defined narrowly: offboarding due to **device change or phone number
  re-registration**, and reconnection after the same. Not general
  offboarding. §7.8's mapping is correct but the copy should say why.
- `entry[].id` is the **WABA id**, and the per-PARTNER payloads include
  `waba_info.{waba_id, owner_business_id, partner_app_id}` plus, for
  Multi-Partner Solutions, `solution_id` and `solution_partner_business_ids`.
  §7.8's `waba_id` tenant resolution is confirmed; note that
  `value.waba_info.waba_id` is a **second, independent** source of the same
  id and can be used to cross-check the `entry.id` lookup.
- `ACCOUNT_RESTRICTION` carries `restriction_info[]` with `restriction_type`
  (9 documented values, including `RESTRICTED_CUSTOMER_INITIATED_MESSAGING`
  and `RESTRICTED_BIZ_INITIATED_MESSAGING`) and `expiration`, with optional
  `remediation`. §7.8's plan to store this in free-text `onboarding_error`
  is workable; if the design later wants to act on restrictions
  programmatically, `restriction_info` is structured and worth a column.
- Events in the documented set that the design maps to "log only" are
  correct: `AD_ACCOUNT_LINKED`, `AUTH_INTL_PRICE_ELIGIBILITY_UPDATE`,
  `BUSINESS_PRIMARY_LOCATION_COUNTRY_UPDATE`, `MM_LITE_TERMS_SIGNED`,
  `VOLUME_BASED_PRICING_TIER_UPDATE`,
  `PARTNER_CLIENT_CERTIFICATION_STATUS_UPDATE`.

### 17.5 Security review of the proposed (not executed) onboarding procedure

Reviewed with `vibe-security` against `references/authentication.md`,
`references/rate-limiting.md` and `references/secrets-and-env.md`. **No
procedure was executed** (B1–B3). Controls already correct in §4.1/§11 and
not repeated here: server-side-only code exchange; never trusting
client-reported asset ids; rejecting unknown body keys; explicit
`requireRole('admin')` with no reliance on `src/middleware.ts`; single-use,
account- and user-bound nonce with an atomic `consumed_at` consume;
Origin/Host allowlist; combined per-user **and** per-IP `checkRateLimit`;
token never returned by any route; `appsecret_proof` derived per request and
never persisted; RLS enabled with zero policies on both new tables plus a
`service_role`-only RPC; in-memory rate-limit counters (the reference warns
against Supabase tables for counters — WACRM does not use them).

Genuine gaps to close before Phase 3:

| # | Sev | Finding | Why it matters / fix |
| --- | --- | --- | --- |
| S1 | **High** | The one-shot sync guard (§4.1 step 5/6, §12 E12) is described as a local "`*_requested_at IS NOT NULL` ⇒ do not call Meta" check. That is **read-then-write, not atomic**. | Meta: the sync *"can only be performed this once"* and a repeat requires **offboarding the customer and re-running the whole Embedded Signup flow**. A concurrent double-submit, a retry, or two admins clicking at once can therefore permanently destroy the customer's history import. Fix: a conditional `UPDATE … WHERE requested_at IS NULL RETURNING` (same pattern as `redeem_whatsapp_onboarding_session`), plus in-process single-flight. |
| S2 | **Medium** | `GET /api/whatsapp/onboarding/session` returns the **plaintext nonce**; `GET /api/whatsapp/onboarding/state` returns token metadata. No `Cache-Control` requirement is stated. | Any intermediary that caches a 200 on these paths leaks a live nonce to another party, defeating the CSRF control that §11.2 rests on. Fix: `Cache-Control: no-store` on both (and on any coexistence state route). |
| S3 | **Medium** | §11.2 requires an Origin/Host allowlist but does not state the behaviour when the allowlist env var is **unset**. | This is the only endpoint that accepts a client-supplied credential (the code). A fail-open allowlist here silently removes the CSRF defence while every other control still appears to be in place. Fix: fail closed, mirroring the existing fail-closed `META_APP_SECRET` posture in `webhook-signature.ts`. |
| S4 | **Medium** | §6.7 lets `resolveAppSecretForId` return `null` when more than one `META_APP_SECRET` is configured with no `META_APP_SECRETS_JSON` map, and then sends **without** `appsecret_proof`. | Defensible for `api_only` (behaviour preservation), wrong for coexistence: there the app is known *by definition* (the `config_id` belongs to `META_APP_ID`), so ambiguity means a misconfiguration, not a legitimate multi-app deployment. Fix: coexistence fails closed; keep the soft fallback only on existing paths. |
| S5 | **Medium** | `whatsapp_webhook_queue.payload` (§5.3) stores the **raw** `history` / `smb_message_echoes` payloads — up to 3 MB and potentially thousands of customer messages — as plaintext `JSONB`, with no retention, size cap, or minimisation stated. | Coexistence turns a metadata-only webhook path into a bulk importer of up to 180 days of customer chat content and phone numbers. RLS-zero-policy protects *access*; nothing bounds *volume or retention*. Fix: state a retention window and drain-delete policy, and a per-row size guard. |
| S6 | **Low** | `GET /api/whatsapp/onboarding/state` returns `token_app_id`, `token_client_business_id` and `token_scopes` by default. | `authentication.md` — "select only the fields the client needs". The checklist in §9.3 needs `token_type`, `expires_at`, `obtained_at` and revocation state; the internal identifiers are not needed and are unnecessary internal-asset disclosure. Fix: select the fields the checklist renders; drop the rest from the response shape. |
| S7 | **Low** | `onboarding_error` is free text intended to hold a Meta error summary. | Meta error bodies can contain values that look like identifiers. Fix: an explicit allowlist of fields written into `onboarding_error` (`code`, `subcode`, `fbtrace_id`, `is_transient`), never a raw Meta body — §11.6 already states the intent; make it testable. |

The three controls Meta's own docs reinforce and the design should call out
explicitly, because they are easy to regress: *"Perform all of the requests
described below using server-to-server requests. Do not use client-side
requests."* (P6, P7); webhooks are **signed by the same app secret** and hit
the same callback, so `verifyMetaWebhookSignature` needs no second
verification path; and an unknown `change.field` must be dropped with **200**
because a non-2xx triggers the 7-day retry loop (P10).

### 17.6 Design decisions that must change

| # | Location | Change |
| --- | --- | --- |
| C1 | §2.2, §14.3, §15 U1, §16, `embedded-signup-extras.ts` | **v3 is not a bridge.** v2 *and* v3 (plus both public previews) are deprecated **2026-10-15**. The dated guard must reject all four. Remove "treat v3 as a short bridge only". |
| C2 | §2.2 / `embedded-signup-extras.ts` | `extras` is a **four-way** switch, not three: stable v4 ⇒ `{}`; **v4-public-preview ⇒ `{ version: 'v4-public-preview' }`** (not empty); v3 ⇒ `{setup, features, featureType, version}`; v2 ⇒ adds `sessionInfoVersion`. |
| C3 | §13.7 | The sandbox-acceptance plan is **not achievable** for coexistence: sandbox numbers cannot send or receive, so C/D/E/F and the messaging half of A/B are impossible there. Sandbox validates only the flow shape and asset return (A, B). Real acceptance needs a Tech Provider test business. |
| C4 | §6.6, §15 U7, §1.5 | Add the **v21.0 removal date of 2027-01-21** as a dated, tracked constraint. Do not hardcode `v25.0` merely because today's docs print it; choose the coexistence version with runway at implementation time. Note the **second** version constant at `src/app/api/whatsapp/templates/sync/route.ts:25`. The per-call override mechanism itself is correct and stays. |
| C5 | §7.4, §13.2 | **New requirement:** the history handler must parse a `messages[]`-shaped change arriving on `field: "history"` (the media-asset enrichment delivery), which has no `history_context` and no `history[].metadata`. §7.4 as written would drop every media enrichment. |
| C6 | §7.5, P2 | **P2 is CONFIRMED** — skip `media_placeholder`. Record the reason: the enrichment webhook reuses the same wamid, so the existing `ignoreDuplicates` insert handles it with no exception to the idempotency boundary. The bounded "media older than 14 days is absent" gap remains. |
| C7 | §7.3, §13.2 | Make explicit that an `edit`/`revoke` event must **never be inserted as a message row** on either field (it carries its own new wamid). Record the trigger windows: customer edit ≈ **15 minutes**, customer revoke ≈ **2 days**. Note that a customer-side `revoke` may target an **agent-side** row (echo or API send), so the lookup must not assume an inbound row. |
| C8 | §8.1, §7.2 | Strengthen the identity-gap section: echo `to` is **the number the business dialled**, and P11 warns a user's *"phone number and ID may not always match"*. So the gap is phone-to-phone as well as BSUID-to-phone. Never treat an echo-derived number as verified identity; keep "log, don't merge". |
| C9 | §6.7, S4 | Coexistence must **fail closed** when the app secret is ambiguous, rather than send without `appsecret_proof`. Keep the soft fallback only on existing paths. |
| C10 | §4.1 step 5/6, §12 E12, S1 | Make the one-shot sync guard **atomic** (conditional update / single-flight). Burning it is unrecoverable without offboarding and a full Embedded Signup re-run. |
| C11 | §11.2, S2, S3 | Add `Cache-Control: no-store` to the onboarding session/state routes, and specify **fail-closed** behaviour for the Origin/Host allowlist when its env var is unset. |
| C12 | §5.3, S5 | State a retention/drain-delete policy and a per-row size guard for `whatsapp_webhook_queue` payloads. |
| C13 | §1.2, §14 | `whatsapp_business_management` is **required** for coexistence (all non-`messages` webhook fields), not "optional in practice". |
| C14 | §14.1 | Add the Tech Provider "Onboard with an existing Solution Partner" (partner solution) and "Onboard without a partner" paths, App Review's video-evidence prerequisite, the "Tech Provider or Tech Partner" naming, and the partner-onboarding location (App Dashboard → Use cases → Customize → WhatsApp use case). |
| C15 | §14.6 | Reword the webhook field list as "at least these"; P10 now documents more fields, including `security`, `user_preferences` and `business_capability_update`. |
| C16 | §2.12 item 4 | Correct the `unsupported.type` list — P14 documents 19 values including `image`, `interactive`, `location`, `reaction`, `poll_creation`, `poll_update`, and restricts `errors[0].code` to `131051`/`131060`. |

### 17.7 Design decisions confirmed (no change needed)

Two supported modes with a `connection_mode` discriminator (§3.1); keep
both paths permanently — Embedded Signup is partner-only and
`api_only` must survive for self-hosters (§2.1); the
`UNIQUE (phone_number_id)` cross-account check as the WABA-hijack control
(§11.4); persist-token-before-`subscribed_apps` so a 30-second code is never
wasted (§6.4); skip `/register` for coexistence (§2.6, pending U-a);
`is_on_biz_app && platform_type === 'CLOUD_API'` as the coexistence probe;
the `whatsapp_webhook_queue` + `UNIQUE (field, payload_digest)` two-layer
idempotency model (§5.3, §8.3), now reinforced by P10's explicit
duplicate-delivery warning; reusing
`(conversation_id, message_id)` for echo and history inserts (§8.2); the
server-minted single-use nonce with atomic consume and Origin/Host checks
(§11.2); zero-policy RLS on the two new server-only tables (§5.6); BISU
token metadata columns including `token_expires_at = NULL` as the documented
default (§2.4, §5.1); `appsecret_proof` per request, never persisted (§6.7);
the `131060` no-insert short-circuit (§7.9), now shown to be correct under
both wamid semantics; `PLAYED → delivered` (P3); no destructive contact sync
(P4); the `history` 180-day/phase/chunk/progress model and monotonic
`GREATEST` updates (§7.4); 24-hour sync window and countdown (§9.3);
never calling `/deregister` on a coexistence row (§2.11, §7.8); the
`account_update` → state mapping (§7.8); suppressed "Not registered" banner
for coexistence rows (§9.5).

### 17.8 Remaining high-risk uncertainties

Ordered by how much damage being wrong causes.

| Rank | Uncertainty | Status | Why it is dangerous | Cheapest way to settle it |
| --- | --- | --- | --- | --- |
| 1 | **U-a / U3 — is `/register` really skipped?** | BLOCKED | If Meta requires it, **every coexistence deployment is silently dead on inbound** and on echoes — the exact failure `docs/whatsapp-architecture.md` records as the reason `/register` exists. Costs the entire feature. | Tech Provider test business, onboarding with `/register` skipped, then send from the app and confirm an echo. No code required — the Embedded Signup Integration Helper can run the four onboarding calls. |
| 2 | **U7 — do the coexistence fields exist on v21.0?** | BLOCKED | Interacts with the **2027-01-21 v21.0 removal**. A coexistence launch pinned to a version about to be deleted fails on a fixed, near date. | With rank 1's test business: one `GET /{phone_number_id}?fields=is_on_biz_app,platform_type` at v21.0 and one `smb_app_data` POST. |
| 3 | **U-b — can a BISU token fetch app-originated media ids?** | BLOCKED | If not, every echo and history attachment is permanently blank. Silent, and it degrades quietly rather than erroring. | Send an image from the business app during the rank-1 test, fetch the returned media id with the business token. |
| 4 | **U5 — do statuses arrive for app-sent messages?** | STILL UNCERTAIN | Medium. Affects inbox tick marks only; the design is safe either way. | Same test: send from the app, watch for a `messages.statuses` delivery with the echo's wamid. |
| 5 | **Does the post-`131060` real delivery reuse the wamid?** | STILL UNCERTAIN | **Low now.** §7.9's no-insert choice is correct under both answers, so this no longer blocks Phase 4. Keep it confirmatory. | First-contact message from a second real WhatsApp account; compare `messages[].id` on the placeholder and the real delivery. |
| 6 | **Does the 14-day Embedded Signup registration window bind coexistence numbers?** | BLOCKED | Low–medium: would mean coexistence numbers must be re-onboarded periodically. Undocumented. | Observe a coexistence number for >14 days without calling `/register`. |
| 7 | **U8 — echo `to` format** | STILL UNCERTAIN | Very low: `normalizePhone` makes it irrelevant. Confirm only. | Any echo delivery. |
| 8 | **U9 — when the 24 h sync window starts** | STILL UNCERTAIN | Very low: the design issues both sync calls immediately. | Compare `request_id` timestamps with onboarding completion. |
| 9 | **U12 — the missing coexistence "Step 2"** | STILL UNCERTAIN | Very low: `extras` is a server-side setting and the mechanism is documented. | Re-read P1 before Phase 3. |
| 10 | **U13 — coexistence/revocation error codes** | BLOCKED | Low: `explainMetaError` degrades gracefully. Do not guess codes. | Collect real codes during the rank-1 test. |
| 11 | **U14 — 20 mps cap signalling** | STILL UNCERTAIN | Low for now; deferred by design. | Broadcast load test on the test business. |
| 12 | **Country availability** | NEW, undocumented | Community reports (non-authoritative) state coexistence is **not available in every country**. If WACRM offers the feature in an unsupported region, onboarding fails late and confusingly. | Meta's WhatsApp Manager availability for the target region; raise with partner support (P1 names the support topics: *"Embedded Signup - Coexistence Onboarding"* and *"Coexistence Data Synchronization APIs and Webhooks"*). |
| 13 | **Inbound loss on some clients** | NEW, anecdotal | There are community reports of coexistence inbound messages from specific clients (iOS in particular) never arriving. If real, it is inbound data loss. | Part of the rank-1 test: exercise inbound from at least one Android and one iOS account. |

Secondary (community, non-authoritative — do not treat as evidence):
coexistence is one-way (app → API, never the reverse), which supports U11;
an existing Cloud-API registration on the number causes
*"Phone number isn't registered with WhatsApp Business"* (codes
`2655095`/`2655048`) during onboarding; a number previously used with
another provider must be unlinked first; Meta's blue verification badge does
not carry across. These are all consistent with, and already implied by,
the official docs; none of them was verified here.

### 17.9 Phase 0 exit status

- **Exit criterion NOT met.** §16 Phase 0 requires U-a, U-b, U4, U7 and U8
  answered from observation; U-a, U-b and U7 remain **BLOCKED** and no
  observation was possible (B1–B3).
- **Nothing blocks starting Phase 1 (schema only).** Every Phase 1 item is
  additive and version-independent, and C1–C16 are documentation and plan
  changes, not schema changes. None of the blocked uncertainties would change
  a column, a CHECK, a unique index or the RPC in §5.
- **Phase 3 (onboarding) is the gate.** C1–C4, C9–C11 and C13 must land
  first, and rank-1/rank-2 evidence should be obtained before the onboarding
  routes are written, because U-a determines the value of
  `registration_mode` and U7 determines the version constant.
- Re-run this section when a Tech Provider test business is available; the
  checklist is §17.2 plus §17.8.

---

## Appendix A — Meta claim → local change map

| Meta claim | Local change |
| --- | --- |
| Embedded Signup is partner-only (M4) | §9.2 disabled card; §14.1 external requirement |
| `feature_type: whatsapp_business_app_onboarding` (M3, M4) | `embedded-signup-extras.ts`; server-supplied `extras` |
| v2 deprecation 2026-10-15 (M3) | dated guard in `embedded-signup-extras.ts`; §15 U1 |
| 30-second single-use code (M2) | inline exchange in `complete`; no queue; no persistence |
| BISU token, never-expiring by default, revocable by the client (M7, M8) | `token_type`, `token_expires_at`, `token_revoked_at`, `token_last_verified_at` |
| `appsecret_proof` required for BISU management (M8) | `resolveAppSecretForId`; `META_APP_SECRETS_JSON` (§6.7) |
| `/register` skipped for coexistence (M4) | `shouldRegisterPhoneNumber`; `registration_mode='skipped_coexistence'` |
| `subscribed_apps` required (M5, M6, M4) | `complete` step 9; `retry-subscribe`; persist-before-subscribe |
| `is_on_biz_app` + `platform_type` (M4) | `getPhoneNumberCoexistenceState`; `is_on_biz_app` / `platform_type` columns; §7.8 probe |
| `history`, `smb_app_state_sync`, `smb_message_echoes` fields (M4) | `processWebhook` dispatch table; §5.3 queue |
| echo shape: `from`=business, `to`=user, no `contacts` (M10) | `echo-identity.ts`; `processEchoMessage` |
| echo `revoke` / `edit` (M10) | `applyRevoke` / `applyEdit`; `messages.deleted_at` |
| history phases / `chunk_order` / `progress` (M4) | `history-progress.ts`; `GREATEST`; monotonic columns |
| history 180 days, group chats excluded (M4) | documented in §7.4 |
| `media_placeholder` + 14-day media window (M4) | skip policy §7.5 |
| history declined ⇒ 2593109 (M4) | `onboarding_state='sync_declined'` |
| 24-hour sync window, once only (M4) | `deadline_at`; local once-only guards; `sync_expired` |
| `history_context.status` values (M4) | `history-status.ts` mapping |
| `131060` first-contact expected (M4, M12) | §7.9 short-circuit |
| `account_update` events + `disconnection_info` (M11) | `account-update.ts`; §7.8; `entry.id` → `waba_id` tenant lookup |
| Deregister blocked in coexistence (M4) | UI copy; no `/deregister` call anywhere |
| 20 mps fixed throughput (M4) | §2.11; §15 U14 (deferred) |
| Companion-device silent inbound loss (M4) | §9.4 pre-flight disclosure |
| Disappearing / view-once / live location disabled (M4) | §9.4 pre-flight disclosure |
| 3 MB payloads, 7-day retries (M9) | `whatsapp_webhook_queue` + drain; `UNIQUE (field, payload_digest)`; `GREATEST` |
| App must be Live; webhooks suppressed in Dev (M9) | §14.6 |
| Customer-service window semantics unchanged (M4) | no change to `send-message.ts` |
