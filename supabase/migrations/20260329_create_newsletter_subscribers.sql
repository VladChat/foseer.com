-- Migration: Create newsletter_subscribers table
-- Purpose: Store newsletter subscription emails with deduplication and RLS security
-- Created: 2026-03-29

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

-- Create index on created_at for sorting
CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_created_at 
    ON newsletter_subscribers(created_at DESC);

-- Add updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_newsletter_subscribers_updated_at
    BEFORE UPDATE ON newsletter_subscribers
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Enable Row Level Security
ALTER TABLE newsletter_subscribers ENABLE ROW LEVEL SECURITY;

-- RLS Policies:
-- 1. Allow anonymous inserts (for form submissions)
CREATE POLICY "Allow anonymous insert for newsletter signup"
    ON newsletter_subscribers
    FOR INSERT
    WITH CHECK (true);

-- 2. Deny all SELECT, UPDATE, DELETE from anonymous users
-- (No policies needed - default is deny when RLS is enabled)

-- Grant insert permission to anon role (required for client-side inserts)
GRANT INSERT ON newsletter_subscribers TO anon;

-- Comment documenting the table
COMMENT ON TABLE newsletter_subscribers IS 'Stores newsletter subscription emails with deduplication and status tracking';
COMMENT ON COLUMN newsletter_subscribers.email IS 'Original email as submitted';
COMMENT ON COLUMN newsletter_subscribers.email_normalized IS 'Lowercase, trimmed email for deduplication';
COMMENT ON COLUMN newsletter_subscribers.source_page IS 'Page URL where the subscription occurred';
COMMENT ON COLUMN newsletter_subscribers.status IS 'Subscription status: pending, confirmed, unsubscribed, bounced';
