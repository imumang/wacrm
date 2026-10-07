-- ============================================================
-- 043_baileys_linked_device
--
-- Adds an unofficial, opt-in WhatsApp transport: WhatsApp Web
-- "linked device", driven by @whiskeysockets/baileys. The point is
-- that the operator's WhatsApp Business number can stay signed in
-- on the phone while WACRM receives the same conversations —
-- something the official Cloud API cannot do.
--
-- THIS IS NOT Meta COEXISTENCE. Meta coexistence
-- (docs/whatsapp-coexistence-design.md) is a first-party Cloud API
-- feature for onboarding the Business *app* onto a WABA, reached
-- through Embedded Signup. It is unimplemented, and it is a
-- different mechanism on a different Meta surface. The column
-- below is named `transport` and its values name *transports*,
-- not coexistence modes, so the two never get conflated.
--
-- Everything here is ADDITIVE. Nothing is dropped, renamed,
-- retyped or tightened, no CHECK is widened, and the two
-- load-bearing constraints on whatsapp_config — UNIQUE(account_id)
-- and UNIQUE(phone_number_id) — are untouched. The official Cloud
-- API path is byte-for-byte unchanged: existing rows land on
-- transport = 'meta_cloud', which is the value every row already
-- behaved as, and every code path that does not read the column
-- keeps its current behaviour.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. whatsapp_config.transport
-- ============================================================
--
-- Which transport carries this account's WhatsApp traffic. One
-- row per account (UNIQUE(account_id) from 017), so this is the
-- account-level mode discriminator.
--
-- NOT NULL DEFAULT 'meta_cloud' is the whole safety story: every
-- pre-existing row reads as the transport it has always used, and
-- no deployment changes behaviour by upgrading. Baileys is
-- reachable only by a deliberate admin action, and only when the
-- deployment also sets BAILEYS_LINKED_DEVICE_ENABLED=true.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS transport TEXT NOT NULL DEFAULT 'meta_cloud';

COMMENT ON COLUMN whatsapp_config.transport IS
  'Which transport carries this account''s WhatsApp traffic. '
  '''meta_cloud'' (default, and every pre-043 row) is the official '
  'WhatsApp Business Cloud API. ''baileys_linked_device'' is the '
  'unofficial WhatsApp Web linked-device integration '
  '(@whiskeysockets/baileys) — opt-in, support-risk, and additionally '
  'gated on the deployment env var BAILEYS_LINKED_DEVICE_ENABLED. '
  'Unknown values degrade to ''meta_cloud'' in '
  'src/lib/whatsapp/transport.ts rather than throwing.';

-- Narrow the domain. Dropped and re-added so a re-run converges on
-- the same definition; the IF EXISTS / IF NOT EXISTS guards are
-- what make that safe. A CHECK (rather than a lookup table) matches
-- the convention every other enum-ish column in this schema uses
-- (account_role_enum aside, which predates it).
ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_transport_check;

ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_transport_check
  CHECK (transport IN ('meta_cloud', 'baileys_linked_device'));

-- ============================================================
-- 2. contacts.wa_jid
-- ============================================================
--
-- The raw WhatsApp transport address for a contact.
--
-- The Cloud API keys a customer on a phone number or a BSUID
-- (migration 040). WhatsApp Web does neither reliably: a JID may be
-- a phone-number JID (`15550783881@s.whatsapp.net`), a device
-- JID, or a LID (`192837465564738@lid`), and the same person can
-- appear under more than one of them across messages. Storing the
-- canonical, device-stripped JID is what makes a future linked-
-- device send addressable at all — see
-- docs/whatsapp-baileys-transport.md § Identity.
--
-- NULLABLE with no default: every existing contact is NULL, and the
-- Meta webhook never writes it (it has no JID). The linked-device
-- ingestion backfills it onto contacts it matches, which is what
-- lets a later message from the same person find the same row
-- again.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS wa_jid TEXT;

COMMENT ON COLUMN contacts.wa_jid IS
  'Canonical WhatsApp JID for this contact (device stripped), e.g. '
  '''15550783881@s.whatsapp.net'' or ''192837465564738@lid''. Written '
  'ONLY by the linked-device transport; NULL for every contact '
  'created through the Cloud API path, which keys on phone / BSUID '
  'instead. Kept alongside contacts.phone because a JID is not '
  'always a phone number and a phone number is not always a usable '
  'send target.';

-- Partial unique index, mirroring migration 040's BSUID index: a
-- JID has exactly one correct spelling, so exact matching is safe
-- and duplicates are a bug worth refusing at the database. Partial
-- because NULLs would otherwise all collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_wa_jid
  ON contacts (account_id, wa_jid)
  WHERE wa_jid IS NOT NULL;

-- ============================================================
-- 3. messages.transport
-- ============================================================
--
-- Which transport delivered this row. NULL on every pre-043 row,
-- which reads as "the Cloud API" — the only thing that could have
-- written them.
--
-- Deliberately NOT a new sender_type: messages.sender_type is a
-- CHECK on ('customer','agent','bot') that the inbox renderer, the
-- public API and every sender_type filter depend on, and widening
-- it would ripple through all of them for no gain. A message the
-- business sent from its phone is genuinely an 'agent' message
-- with a different origin, which is exactly what this column says.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS transport TEXT;

COMMENT ON COLUMN messages.transport IS
  'Transport that delivered this row: ''meta_cloud'' (Cloud API '
  'webhook), ''baileys_linked_device'' (linked device). NULL on '
  'every row written before migration 043, which is equivalent to '
  '''meta_cloud'' — the only transport that existed. Used for '
  'provenance and diagnostics; NOT a tenant key, and not consulted '
  'by any sender_type filter.';

-- ============================================================
-- 4. whatsapp_linked_devices
-- ============================================================
--
-- The linked-device session for an account. One row per account.
--
-- The Baileys auth state (Signal identity keys, noise key, prekeys,
-- the adv secret) is a CREDENTIAL of the same class as
-- whatsapp_config.access_token: whoever holds it can act as the
-- business on WhatsApp indefinitely, and it cannot be rotated or
-- revoked from inside WACRM. It is therefore:
--
--   * stored AES-256-GCM encrypted with the deployment's existing
--     ENCRYPTION_KEY (src/lib/whatsapp/encryption.ts) — the same
--     primitive, same key, no new crypto;
--   * never selected by any route, never serialised into a
--     response, never logged;
--   * readable only through the service role.
--
-- RLS is enabled with NO policies, so the anon and authenticated
-- roles can neither read nor write it even if a client-side query
-- is attempted. Every access is server-side with the service role,
-- which is the same reasoning that makes
-- bump_conversation_on_inbound service_role-only. The UI reads
-- only the non-secret columns (status, me_jid, timestamps) through
-- an admin-gated route that selects them explicitly.
CREATE TABLE IF NOT EXISTS whatsapp_linked_devices (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),

  -- Tenancy. One linked-device session per account. CASCADE so
  -- deleting an account removes its session, consistent with
  -- every other tenant child in this schema.
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- Audit only. Which member paired the device. NOT the tenancy
  -- key (AGENTS.md / docs/database-architecture.md).
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- The AES-256-GCM ciphertext of the serialised Baileys auth
  -- state, in the `iv:ct:authTag` shape encryption.ts produces.
  -- NULL until the account is paired; a non-NULL value is what
  -- makes this row a live session.
  --
  -- Rotating ENCRYPTION_KEY orphans it exactly as it orphans every
  -- stored Meta token, and recovery is the same: re-pair.
  auth_state TEXT,

  -- Connection state, mirrored from the live socket so the settings
  -- UI can render a truthful status after a restart (the socket
  -- lives in the Node process, the row survives it).
  --   disconnected      no socket, or explicitly disconnected
  --   connecting        socket opening / handshaking
  --   connected         authenticated and online
  --   reconnecting      dropped, retry scheduled
  --   re_pair_required  logged out or replaced; the auth state is
  --                     dead and only a fresh pairing fixes it
  status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (status IN (
      'disconnected', 'connecting', 'connected',
      'reconnecting', 're_pair_required'
    )),

  -- Our own identity, from creds.me. Non-secret, and the only way
  -- the UI can tell the operator WHICH number got paired.
  me_jid TEXT,
  me_lid TEXT,
  -- `platform` from AuthenticationCreds — 'smba' for a business
  -- account. Informational.
  platform TEXT,

  paired_at TIMESTAMPTZ,
  last_connected_at TIMESTAMPTZ,
  last_disconnected_at TIMESTAMPTZ,
  -- Short operator-facing reason for the last state change. Never a
  -- credential, never a raw stack, never a token.
  last_error TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (account_id)
);

COMMENT ON TABLE whatsapp_linked_devices IS
  'Unofficial WhatsApp Web linked-device sessions (Baileys), one per '
  'account. OPT-IN: an account with no row here is on the Cloud API. '
  'auth_state is an AES-256-GCM credential and is never returned to a '
  'client. Zero RLS policies by design — service role only.';

COMMENT ON COLUMN whatsapp_linked_devices.auth_state IS
  'AES-256-GCM ciphertext (iv:ct:authTag) of the Baileys '
  'AuthenticationState, encrypted with the deployment ENCRYPTION_KEY. '
  'A full account credential: treat a leak as account compromise. '
  'Never returned by any route and never logged.';

CREATE INDEX IF NOT EXISTS idx_whatsapp_linked_devices_account
  ON whatsapp_linked_devices (account_id);

ALTER TABLE whatsapp_linked_devices ENABLE ROW LEVEL SECURITY;

-- Intentionally NO policies. A signed-in member of the account has
-- no legitimate need to read the ciphertext, and a policy that
-- granted it would be a policy that could be wrong. The UI goes
-- through an admin-gated route that selects the non-secret columns
-- with the service role.

-- ============================================================
-- 5. set_updated_at
-- ============================================================
DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_linked_devices;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON whatsapp_linked_devices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
