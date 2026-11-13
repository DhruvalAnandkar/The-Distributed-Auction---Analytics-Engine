-- Day 2: Database schema for the PostgreSQL database
-- This is the SQL setup script for the PostgreSQL database used in our application
-- It defines the necessary tables and their relationships.
-- Enable the UUID(Universally Unique Identifier) extension if needed later
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
-- Core USER table
CREATE TABLE IF NOT EXISTS users(
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    failed_login_count INTEGER DEFAULT 0 NOT NULL,
    locked_until TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP WITH TIME ZONE;

-- Core REFRESH_TOKENS table
CREATE TABLE IF NOT EXISTS refresh_tokens(
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) UNIQUE NOT NULL,
    family_id UUID NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family_id ON refresh_tokens(family_id);

-- Core AUCTION table
CREATE TABLE IF NOT EXISTS auctions(
    id SERIAL PRIMARY KEY,
    title VARCHAR(100) NOT NULL,
    description TEXT,
    start_price NUMERIC(12, 2) NOT NULL CHECK (start_price > 0),
    current_price NUMERIC(12, 2) NOT NULL CHECK (current_price >= start_price),
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'CLOSED')),
    seller_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    ends_at TIMESTAMP WITH TIME ZONE NOT NULL,
    original_ends_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE auctions ADD COLUMN IF NOT EXISTS original_ends_at TIMESTAMP WITH TIME ZONE;

-- Index frequently scanned columns to optimize query execuation
CREATE INDEX IF NOT EXISTS idx_auctions_status ON auctions(status);

-- Core BIDS table
CREATE TABLE IF NOT EXISTS bids(
    id SERIAL PRIMARY KEY,
    auction_id INTEGER REFERENCES auctions(id) ON DELETE CASCADE,
    bidder_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bids_auction_amount ON bids(auction_id, amount DESC);
CREATE INDEX IF NOT EXISTS idx_bids_bidder_id ON bids(bidder_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_bids_created_at ON bids(created_at);

-- Core NOTIFICATIONS table
CREATE TABLE IF NOT EXISTS notifications(
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    auction_id INTEGER REFERENCES auctions(id) ON DELETE CASCADE,
    type VARCHAR(30) NOT NULL CHECK (type IN ('OUTBID')),
    read BOOLEAN DEFAULT FALSE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, read) WHERE read = FALSE;

-- Core WATCHLIST table
CREATE TABLE IF NOT EXISTS watchlist(
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    auction_id INTEGER REFERENCES auctions(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, auction_id)
);

CREATE INDEX IF NOT EXISTS idx_watchlist_user_created ON watchlist(user_id, created_at DESC);

-- Core IDEMPOTENCY_KEYS table
CREATE TABLE IF NOT EXISTS idempotency_keys(
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    key VARCHAR(255) NOT NULL,
    request_hash VARCHAR(64) NOT NULL,
    status_code INTEGER NOT NULL,
    response_body JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created ON idempotency_keys(created_at);

-- Core DOMAIN_EVENTS outbox table
CREATE TABLE IF NOT EXISTS domain_events(
    id SERIAL PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL,
    published_at TIMESTAMP WITH TIME ZONE,
    claimed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_domain_events_unpublished ON domain_events(published_at, claimed_at, id);
