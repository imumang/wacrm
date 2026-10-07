-- Remove the unofficial linked-device transport introduced by migration 043.
--
-- Migration 043 has already been applied, so this is intentionally a forward
-- migration rather than an edit to migration history. All removed columns were
-- written only by the linked-device implementation; the official Meta Cloud
-- API uses contacts.phone / contacts.wa_user_id and needs no transport marker.

DROP TABLE IF EXISTS whatsapp_linked_devices;

DROP INDEX IF EXISTS idx_contacts_account_wa_jid;

ALTER TABLE contacts
  DROP COLUMN IF EXISTS wa_jid;

ALTER TABLE messages
  DROP COLUMN IF EXISTS transport;

ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_transport_check;

ALTER TABLE whatsapp_config
  DROP COLUMN IF EXISTS transport;
