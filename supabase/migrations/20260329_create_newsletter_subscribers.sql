-- Migration: Create newsletter_subscribers table
-- Purpose: Store newsletter subscription emails with deduplication and RLS security
-- Created: 2026-03-29
-- Updated: 2026-03-30 (fixed RLS policies and grants)

-- Create the newsletter_subscribers table
CREATE TABLE IF NOT EXISTS newsletter_subscribers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    email_normalized TEXT NOT NULL,
    source_page TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'unsubscribed', 'bounced')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create index on email_normalized for fast lookups
CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_email_normalized 
    ON newsletter_subscribers(email_normalized);

-- Create unique constraint on email_normalized to prevent duplicates
CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_subscribers_email_unique 
    ON newsletter_subscribers(email_normalized);

-- Enable Row Level Security
ALTER TABLE newsletter_subscribers ENABLE ROW LEVEL SECURITY;

-- Grant permissions to anon role (required for client-side inserts via Supabase API)
GRANT USAGE ON SCHEMA public TO anon;
GRANT ALL ON newsletter_subscribers TO anon;

-- Drop existing policies if any (for idempotency)
DROP POLICY IF EXISTS "anon_insert_policy" ON newsletter_subscribers;
DROP POLICY IF EXISTS "anon_select_policy" ON newsletter_subscribers;
DROP POLICY IF EXISTS "Enable insert for anonymous users" ON newsletter_subscribers;

-- RLS Policy: Allow anonymous INSERT (for newsletter signup form)
CREATE POLICY "anon_insert_policy"
    ON newsletter_subscribers
    FOR INSERT
    TO anon
    WITH CHECK (true);

-- RLS Policy: Allow anonymous SELECT (required for RETURNING clause in INSERT...SELECT)
CREATE POLICY "anon_select_policy"
    ON newsletter_subscribers
    FOR SELECT
    TO anon
    USING (true);

-- Note: UPDATE and DELETE are intentionally NOT granted to anon role
-- Only server-side operations with service_role key should modify/delete records

-- Comment documenting the table
COMMENT ON TABLE newsletter_subscribers IS 'Stores newsletter subscription emails with deduplication and status tracking';
COMMENT ON COLUMN newsletter_subscribers.email IS 'Original email as submitted';
COMMENT ON COLUMN newsletter_subscribers.email_normalized IS 'Lowercase, trimmed email for deduplication';
COMMENT ON COLUMN newsletter_subscribers.source_page IS 'Page URL where the subscription occurred';
COMMENT ON COLUMN newsletter_subscribers.status IS 'Subscription status: pending, confirmed, unsubscribed, bounced';
