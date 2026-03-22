-- ============================================================================
-- SUPPORT TICKET SYSTEM
-- ============================================================================
-- Support ticket system for bug reports, feature requests, and general questions.
-- Users submit from the dashboard. Admins manage and reply from the admin area.
--
-- Tables: support_tickets, support_ticket_replies
-- Patterns: RLS with (SELECT auth.uid()), partial indexes, timestamp triggers
-- ============================================================================

-- ============================================================================
-- SUPPORT TICKETS TABLE
-- ============================================================================

CREATE TABLE support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('bug', 'feature', 'question')),
  subject TEXT NOT NULL CHECK (char_length(subject) BETWEEN 3 AND 200),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 10 AND 5000),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  screenshot_urls TEXT[] DEFAULT '{}',
  admin_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- SUPPORT TICKET REPLIES TABLE
-- ============================================================================

CREATE TABLE support_ticket_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL CHECK (author_type IN ('user', 'admin')),
  author_id UUID NOT NULL,
  message TEXT NOT NULL CHECK (char_length(message) BETWEEN 1 AND 5000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- User's tickets sorted by newest first
CREATE INDEX idx_support_tickets_user ON support_tickets(user_id, created_at DESC);

-- Admin filtering by status
CREATE INDEX idx_support_tickets_status ON support_tickets(status, created_at DESC);

-- Replies for a ticket in chronological order
CREATE INDEX idx_support_ticket_replies_ticket ON support_ticket_replies(ticket_id, created_at ASC);

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_ticket_replies ENABLE ROW LEVEL SECURITY;

-- Users can view their own tickets
CREATE POLICY "support_tickets_select_own" ON support_tickets
  FOR SELECT USING (user_id = (SELECT auth.uid()));

-- Users can create their own tickets
CREATE POLICY "support_tickets_insert_own" ON support_tickets
  FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));

-- Users can view replies on their own tickets
CREATE POLICY "support_ticket_replies_select_own" ON support_ticket_replies
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM support_tickets st
      WHERE st.id = support_ticket_replies.ticket_id
      AND st.user_id = (SELECT auth.uid())
    )
  );

-- Users can add replies to their own tickets
CREATE POLICY "support_ticket_replies_insert_own" ON support_ticket_replies
  FOR INSERT WITH CHECK (
    author_type = 'user'
    AND author_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM support_tickets st
      WHERE st.id = support_ticket_replies.ticket_id
      AND st.user_id = (SELECT auth.uid())
    )
  );

-- ============================================================================
-- UPDATED_AT TRIGGER
-- ============================================================================

CREATE OR REPLACE FUNCTION update_support_ticket_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER support_tickets_updated
  BEFORE UPDATE ON support_tickets
  FOR EACH ROW
  EXECUTE FUNCTION update_support_ticket_timestamp();
