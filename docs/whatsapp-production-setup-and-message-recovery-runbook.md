# WhatsApp Production Setup and Message Recovery Runbook

**Status:** Verified working on 7 October 2026

**Scope:** Clear Waste Removal development deployment at `chat.clearwasteremoval.uk`
**Transport:** Official Meta WhatsApp Cloud API only

> Security rule: never add access tokens, app secrets, verification tokens, PINs,
> passwords, encryption keys, or service-role keys to this document, source code,
> command output, screenshots, Git history, or AI memory.

## Contents

1. [Known-good production state](#known-good-production-state)
2. [What was configured](#what-was-configured)
3. [How message delivery works](#how-message-delivery-works)
4. [Incident summary and root cause](#incident-summary-and-root-cause)
5. [Recovery decision tree](#recovery-decision-tree)
6. [Detailed diagnostic procedure](#detailed-diagnostic-procedure)
7. [Safe App Secret recovery](#safe-app-secret-recovery)
8. [Verification procedure](#verification-procedure)
9. [Future app or phone-number replacement](#future-app-or-phone-number-replacement)
10. [Security and operational rules](#security-and-operational-rules)

## Known-good production state

The following configuration was verified end to end with a real customer-side
WhatsApp account:

| Item                         | Verified value                                           |
| ---------------------------- | -------------------------------------------------------- |
| Business portfolio           | Clear Waste Removal Ltd                                  |
| Business ID                  | `1299490705293304`                                       |
| Meta app                     | CWR WACRM                                                |
| Meta App ID                  | `1117063704192177`                                       |
| WhatsApp Business Account ID | `862105596891477`                                        |
| Business phone               | `+44 7909 775962`                                        |
| Phone Number ID              | `1401418003045411`                                       |
| Public WACRM URL             | `https://chat.clearwasteremoval.uk`                      |
| Callback URL                 | `https://chat.clearwasteremoval.uk/api/whatsapp/webhook` |
| App state                    | Published                                                |
| WACRM connection state       | Connected and registered                                 |

Verified behavior:

- A message sent from a personal WhatsApp account appeared in the WACRM inbox.
- A reply sent from WACRM reached the personal WhatsApp account.
- The Cloudflare tunnel, Meta subscription, webhook signature verification,
  inbound database persistence, inbox display, and outbound Cloud API path all
  worked together.

The number and app are temporary development assets. See
[Future app or phone-number replacement](#future-app-or-phone-number-replacement)
before deleting or replacing either one.

## What was configured

### Local/public routing

- `chat.clearwasteremoval.uk` was routed through the Cloudflare Tunnel running
  on this PC.
- The public hostname reaches the local WACRM Next.js development server.
- The Cloudflared Windows service was verified running automatically.
- The service uses a protected token file; its contents must never be copied
  into this document or committed.

### WACRM credentials

The WhatsApp settings page was populated with:

- Phone Number ID
- WhatsApp Business Account ID
- Permanent System User access token
- Webhook verification token
- Two-step verification PIN

These values belong in protected configuration only. WACRM encrypts the stored
access token and verification token. The two-step PIN is used for Meta
registration and is not persisted by the webhook route.

The System User was assigned the CWR WACRM app and the Clear Waste Removal Ltd
WhatsApp account with the WhatsApp messaging, phone-number, and template
permissions needed by WACRM.

### Meta webhook

The following callback was verified:

```text
https://chat.clearwasteremoval.uk/api/whatsapp/webhook
```

The CWR WACRM app subscribes to these five fields:

- `account_update`
- `message_statuses`
- `message_template_status_update`
- `messages`
- `phone_number_name_update`

The WhatsApp account is subscribed to CWR WACRM, and the app is published. Both
the app-level webhook configuration and the account-level app subscription are
required for reliable real-user events.

### Meta app metadata

The following required app details were saved before publication:

- Privacy policy: `https://clearwasteremoval.uk/privacy-policy/`
- Terms: `https://clearwasteremoval.uk/terms-and-conditions/`
- Data-deletion instructions: the privacy-policy page
- Clear Waste Removal app icon
- Meta category: Business and pages

### Local backups created during setup

The following backups were created before sensitive configuration changes:

- `.env.local.backup-20261006-155935`
- `.env.local.backup-20261007-103512-app-secret`

Do not commit these files. They may contain credentials and must remain covered
by the repository's `.env*` ignore rule.

## How message delivery works

### Verification token: callback ownership check

The verification token is a custom shared string chosen during setup. Meta uses
it only for the webhook `GET` challenge performed by **Verify and save**.

WACRM's `GET /api/whatsapp/webhook` handler:

1. Reads `hub.mode`, `hub.challenge`, and `hub.verify_token`.
2. Decrypts stored WACRM verification tokens.
3. Returns the challenge when any configured account has a matching token.
4. Returns HTTP `403` when none match.

A verification-token mismatch prevents webhook verification or later
re-verification. It does **not** produce an invalid POST signature error.

Meta normally leaves the verification-token field blank after a successful
save. A blank field in the dashboard does not prove that no token is configured.

### App Secret: every event-delivery signature

The App Secret is generated by Meta and belongs to one specific Meta app. Meta
signs every webhook `POST` using that app's secret in
`X-Hub-Signature-256`.

WACRM's `POST /api/whatsapp/webhook` handler:

1. Reads the exact raw request body.
2. Validates `X-Hub-Signature-256` using `META_APP_SECRET`.
3. Returns HTTP `401` when the signature is invalid.
4. Parses and acknowledges a valid request with HTTP `200`.
5. Processes the event asynchronously through Next.js `after()`.
6. Resolves the account using Meta's `phone_number_id`.
7. Creates or finds the contact and conversation.
8. Persists the message idempotently.
9. Updates the inbox and dispatches downstream flows, automations, AI, and
   public webhook events as applicable.

`META_APP_SECRET` supports a comma-separated list. This is intentional: one
WACRM deployment can receive signed events from multiple Meta apps, and every
app has a different secret.

### Outbound replies

Replies use the encrypted permanent System User access token and the Phone
Number ID. A working inbound path does not automatically prove that the access
token can send, and a working outbound path does not prove that webhook
signatures are accepted. Test both directions.

## Incident summary and root cause

### Symptoms

- WhatsApp showed the test message as sent and delivered.
- The message did not appear in WACRM.
- The WACRM inbox showed no conversations.
- The local `messages` table had zero rows.
- Meta was configured with the correct callback and subscriptions.
- The app was published and eligible for real webhook traffic.

### Evidence

The Next.js development log repeatedly reported:

```text
[webhook] rejected request with invalid signature
```

This proved that:

- DNS and the Cloudflare tunnel were working.
- Meta was reaching the WACRM route.
- The failure happened before JSON processing or database persistence.
- The verification token was not the failing credential.

### Root cause

`.env.local` contained one App Secret, but the business had two Meta apps. The
configured secret belonged to the other app and could not validate webhook
events signed by CWR WACRM (`1117063704192177`).

### Fix

The CWR WACRM App Secret was retrieved from the correct Meta app and appended
to `META_APP_SECRET` while preserving the existing secret:

```dotenv
# Illustrative placeholders only. Never put real values in documentation.
META_APP_SECRET=<existing-app-secret>,<cwr-wacrm-app-secret>
```

Before the change, `.env.local` was backed up. The secret was transferred
without printing it, the temporary transfer artifact was deleted, and Next.js
confirmed that it reloaded `.env.local`.

The focused signature suite then passed all 15 tests, including multi-secret
acceptance. A fresh real message was received in WACRM, and a WACRM reply was
received on the phone.

No application source code was changed to resolve this incident.

## Recovery decision tree

Use the first branch matching the observed evidence.

| Evidence                                                            | Likely boundary                                                              | Next action                                                                                        |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| No request or webhook log entry                                     | Meta subscription, app publication, DNS, tunnel, or local server             | Check public callback reachability, Cloudflared, app publication, fields, and account subscription |
| `Verification token mismatch` or callback **Verify and save** fails | Verification-token handshake                                                 | Re-enter the same current WACRM verification token in Meta and verify again                        |
| `rejected request with invalid signature`                           | App Secret                                                                   | Confirm the signing app, then safely add that app's secret to `META_APP_SECRET`                    |
| HTTP `200`, followed by `No config found for phone_number_id`       | WACRM configuration mapping                                                  | Check Phone Number ID and saved `whatsapp_config` row                                              |
| HTTP `200`, followed by database/decryption errors                  | Service-role key, encryption key, schema, or processing                      | Read the first processing error and repair that exact dependency                                   |
| Message row exists but inbox is empty                               | Tenant/account query, RLS, realtime, or UI filtering                         | Compare message conversation/account ownership with the signed-in account                          |
| Inbound works but outbound reply fails                              | Access token, permissions, registration, phone status, billing, or Graph API | Use the returned Meta error; test WACRM connection and System User asset assignments               |
| Outbound works but inbound fails                                    | Webhook configuration or signature                                           | Follow the inbound branches above; outbound success does not validate the webhook                  |

## Detailed diagnostic procedure

### 1. Preserve evidence

- Do not immediately regenerate tokens or change several settings together.
- Record the approximate send time and a distinctive test phrase.
- Check the browser inbox, server log, and database before modifying anything.
- Never paste secret values into a terminal command that will be logged.

### 2. Confirm the public path

Check that:

- `https://chat.clearwasteremoval.uk` loads.
- The local Next.js process is running.
- The Cloudflared Windows service is running.
- Meta still shows the exact callback URL.

If Meta never reaches the route, inspect Cloudflare Tunnel routing before
changing tokens or application code.

### 3. Confirm Meta configuration with the official WhatsApp tools

Use the official `whatsapp_business_tools` MCP read-only onboarding status with:

- Business ID `1299490705293304`
- App ID `1117063704192177`
- Phone Number ID `1401418003045411`

For the current setup, the authoritative result should show:

- Phone registered
- Callback configured
- Five subscribed fields
- Clear Waste Removal Ltd account subscribed to CWR WACRM
- CWR WACRM published

Do not treat app-level callback configuration as proof of account-level event
routing; verify both.

### 4. Read the WACRM server log

Use a bounded, secret-safe search:

```powershell
rtk powershell -NoProfile -Command `
  'Get-Content -LiteralPath ".next\dev\logs\next-development.log" -Tail 250 |
   Select-String -Pattern "webhook|whatsapp|signature|Error processing" -Context 2,4'
```

Interpret the first error at the time of the test. Do not fix a later secondary
error before the earliest failing boundary.

### 5. Check whether the message was persisted

The local database container is `supabase_db_wacrm`. Use read-only SQL:

```powershell
rtk docker exec supabase_db_wacrm psql -U postgres -d postgres -P pager=off -c `
  "SELECT created_at, sender_type, content_text, status
   FROM public.messages
   ORDER BY created_at DESC
   LIMIT 10;"
```

If the server rejected the request before processing, no message row will
exist. If the row exists, continue with conversation ownership, RLS, realtime,
and inbox-filter diagnostics instead of changing Meta configuration.

### 6. Inspect secret configuration without revealing it

Only report presence and slot count. Never print the value:

```powershell
rtk powershell -NoProfile -Command `
  '$line = Get-Content -LiteralPath ".env.local" |
     Where-Object { $_ -match "^META_APP_SECRET=" } |
     Select-Object -First 1;
   if (-not $line) { "META_APP_SECRET: missing" }
   else {
     $value = $line.Substring($line.IndexOf("=") + 1).Trim();
     $count = @($value.Split(",") |
       Where-Object { $_.Trim().Length -gt 0 }).Count;
     "META_APP_SECRET: present; configured secret slots=$count"
   }'
```

Slot count does not prove correctness. It only confirms how many app secrets
the verifier will try.

## Safe App Secret recovery

Follow this only when logs prove an invalid webhook signature.

1. Identify the exact Meta app delivering the events.
2. Open that app's **App settings → Basic** page.
3. Reveal its App Secret after Meta re-authentication.
4. Do not display, dictate, paste into chat, or log the value.
5. Back up `.env.local` with a timestamped, ignored filename.
6. Preserve any existing `META_APP_SECRET` entries used by other active apps.
7. Append the new app's secret once, comma-separated.
8. Confirm the secret appears only in protected configuration.
9. Confirm Next.js logs `Reload env: .env.local`; restart the development
   server only if it does not reload.
10. Delete any temporary transfer file immediately.
11. Run the focused signature test.
12. Send a brand-new real inbound message.

Focused test command:

```powershell
rtk npm test -- src/lib/whatsapp/webhook-signature.test.ts
```

Expected result for the verified codebase: one test file and 15 passing tests.

Do not replace a multi-app value with only the newest secret unless every other
app has been retired and its traffic has been verified absent.

## Verification procedure

After any repair, verify each boundary in order:

1. Send a new, uniquely worded message from a personal WhatsApp account.
2. Confirm there is no new invalid-signature entry in the server log.
3. Confirm a new `messages` row exists.
4. Confirm the conversation appears in the correct WACRM account inbox.
5. Reply from WACRM.
6. Confirm the reply reaches the original phone.
7. Re-run official Meta onboarding status if subscription or publication was
   changed.

Only declare recovery complete after both inbound and outbound real-message
tests succeed.

## Future app or phone-number replacement

The intended future production migration is to create a new Meta app and a new
business phone number under the same business portfolio, then retire the
temporary development assets.

Use this order to avoid downtime:

1. Create and configure the new Meta app under the correct business.
2. Add and verify the new phone number.
3. Assign the app and WhatsApp account to the System User with the required
   permissions.
4. Generate a permanent System User token for the new asset assignments.
5. Save the new Phone Number ID, account ID, token, verification token, and PIN
   in WACRM.
6. Register the number and subscribe its account to the new app.
7. Configure the same public callback URL or an intentionally new one.
8. Subscribe the required webhook fields.
9. Add the new app's App Secret to `META_APP_SECRET` without removing working
   secrets.
10. Add privacy, terms, data-deletion, logo, category, and other required app
    metadata.
11. Publish the new app.
12. Verify official onboarding status.
13. Complete real inbound and outbound message tests.
14. Only after successful tests, remove the old app/number configuration and
    its old App Secret.
15. Take a new backup and update this runbook with the replacement IDs and
    verification date.

Do not delete the current app or number first. Asset deletion is irreversible
and would remove the known-good fallback before the replacement is proven.

## Security and operational rules

- Keep `META_APP_SECRET` server-only. Never use a `NEXT_PUBLIC_` prefix.
- Keep permanent access tokens, verification tokens, PINs, encryption keys,
  service-role keys, and tunnel tokens out of Git.
- `.env.local`, `.env.whatsapp-setup.local`, and timestamped `.env*` backups
  are ignored by the repository. Verify this before creating any new secret
  file.
- Back up before changing a credential, but treat the backup as sensitive.
- Preserve fail-closed webhook signature validation. Never bypass it to make a
  test message appear.
- Do not change the callback verification token to repair an invalid POST
  signature; they protect different protocol stages.
- Change one variable at a time and test after each change.
- Prefer the official WhatsApp Business Tools MCP for Meta asset discovery and
  status checks. WACRM production messaging must continue through the official
  Meta Cloud API, not through the MCP.
- Do not infer production state from the local database alone.
- Record exact observed errors and timestamps, but redact identifiers that are
  not required for diagnosis and never record secrets.

## Related implementation references

- `src/app/api/whatsapp/webhook/route.ts`
- `src/lib/whatsapp/webhook-signature.ts`
- `src/lib/whatsapp/webhook-signature.test.ts`
- `docs/whatsapp-architecture.md`
- `docs/whatsapp-coexistence-design.md`

Review this runbook after any app, phone-number, callback, deployment, tunnel,
token-storage, or webhook-signature change.
