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
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Core AUCTION table
CREATE TABLE IF NOT EXISTS auctions(
    id SERIAL PRIMARY KEY,
    title VARCHAR(100) NOT NULL,
    description TEXT,
    start_price NUMERIC(12, 2) NOT NULL CHECK (start_price > 0),
    current_price NUMERIC(12, 2) NOT NULL CHECK (current_price >= start_price),
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'CLOSED')),
    seller_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    ends_id TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index frequently scanned columns to optimize query execuation
CREATE INDEX if NOT EXISTS idx_auctions_status ON auctions(status);