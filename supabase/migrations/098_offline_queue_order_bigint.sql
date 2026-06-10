-- Migration 098: widen offline_command_queue.queue_order INTEGER -> BIGINT.
--
-- BUG (latent, found by the bug-hunt 2026-06-09; fixed as part of the web
-- offline-sync loop 2026-06-10):
--   The web offline-sync client sets queue_order = Date.parse(created_at), an
--   epoch-milliseconds value (~1.7e12 today). The column was INTEGER (INT4,
--   max 2,147,483,647 ≈ 2.1e9), so every offline-queue insert would overflow
--   with "integer out of range" (SQLSTATE 22003) and abort. Combined with the
--   FK bug (machine_id was set to user_id) the sync path never succeeded — it
--   was unreachable only because no producer fed it. Now that a producer +
--   delivery exist, queue_order must hold an ms-epoch (or any monotonic 64-bit)
--   value, so BIGINT is required.
--
-- queue_order stays NOT NULL with no default (the client supplies a monotonic
-- ordering value per command). BIGINT is a non-lossy widening of INTEGER, so
-- existing rows are preserved; the supporting index
-- idx_offline_queue_pending (user_id, machine_id, queue_order) rebuilds
-- automatically on the column rewrite.
--
-- Governing: data-integrity (no silent insert failure on a NOT NULL queue).

ALTER TABLE public.offline_command_queue
  ALTER COLUMN queue_order TYPE BIGINT;
