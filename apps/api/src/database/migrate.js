/**
 * @fileoverview Database migration execution script.
 * Provides programmatic execution of schema definitions against the target PostgreSQL database
 * using the configured node-postgres connection pool. Ensures state synchronization between
 * application models and the persistent data tier.
 * @module migrations/runMigrations
 */

import fs from 'fs';
import path from 'path';
import pool from '../config/db.js';
import { fileURLToPath } from 'url';

/**
 * Absolute filesystem path to the current module file.
 * Required for POSIX-compliant path resolution in ECMAScript modules.
 * @type {string}
 */
const __filename = fileURLToPath(import.meta.url);

/**
 * Absolute directory name of the current module.
 * @type {string}
 */
const __dirname = path.dirname(__filename);

/**
 * Executes the schema migration script against the configured PostgreSQL database.
 *
 * Reads the raw SQL definitions from the local file system synchronously,
 * issues the DDL/DML statements via the shared database pool, and ensures
 * deterministic resource clean-up by terminating all active pool clients.
 *
 * @async
 * @function runMigrations
 * @returns {Promise<void>} Resolves when the migration completes and database connections are closed.
 * @throws {Error} Logs errors encountered during file I/O or query execution to stderr.
 */
const runMigrations = async () => {
    console.log('[Migration] Starting database migrations...');
    try {
        /**
         * Absolute path to the migration SQL schema file.
         * @type {string}
         */
        const schemaPath = path.join(__dirname, 'schema.sql');

        /**
         * Raw SQL buffer contents encoded as UTF-8.
         * @type {string}
         */
        const schemaSQL = fs.readFileSync(schemaPath, 'utf8');

        // Execute batch DDL/DML commands against the PostgreSQL pool
        await pool.query(schemaSQL);
        console.log('[Migration] Database migrations completed successfully.'); 
    } catch (err) {
        console.error(`[Migration Error] Failed to run migrations: ${err.message}`);
    } finally {
        // Guarantee disposal of pool connections to prevent hanging process lifecycle
        await pool.end();
        console.log('[Migration] Database connection pool closed.');
    }
};

runMigrations();
