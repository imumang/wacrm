-- ============================================================
-- 048_ai_usage_image_analysis_mode.sql — token usage for image analysis
--
-- Objective 08 connected a vision model behind the `analyze_images`
-- read tool. That tool spends real tokens on the account's
-- bring-your-own key, so its spend must land in the *existing*
-- `ai_usage_log` cost-visibility trail rather than in a second,
-- parallel accounting system.
--
-- The only blocker is `mode`, whose CHECK constraint enumerates the
-- two surfaces that existed when the table was created
-- (`auto_reply`, `draft`). Widening an enum-valued CHECK is
-- additive: no column is added, no row is rewritten, no data is
-- migrated, and existing rows keep their meaning. The TypeScript
-- writer (`src/lib/ai/usage.ts`) is widened in the same change.
--
-- RLS, grants, and indexes are unchanged. This table is still
-- admin+-read-only and service-role-written; `analyze_images` is a
-- read tool and never writes a customer-facing row.
--
-- Idempotent - safe to run multiple times.
-- ============================================================

ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_mode_check;

ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_mode_check
  CHECK (mode IN ('auto_reply', 'draft', 'image_analysis'));