// Day 3  We will do direct database migrations using node-postgres (pg) library. 
// We will create a migration script that connects to the PostgreSQL database and executes SQL commands to create tables,
// Insert initial data, or modify existing structures. 
// This approach allows us to manage database schema changes programmatically and ensures that our database is in sync with our application code.

import fs from'fs';
import path from 'path';
import pool from '../config/db.js';
import {fileURLToPath} from 'url';

//Recreate __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


// Function to run SQL migration scripts from the migrations directory
const runMigrations = async () => {
    console.log('[Migration] Starting database migrations...');
    try {
        //1. Locate the schema.sql file
        const schemaPath = path.join(__dirname, 'schema.sql');
        //2. Read the SQL file
        const schemaSQL = fs.readFileSync(schemaPath, 'utf8');
        //3. Execute the SQL commands
        await pool.query(schemaSQL);
        console.log('[Migration] Database migrations completed successfully.'); 
    }
    catch(err){
        console.error(`[Migration Error] Failed to run migrations: ${err.message}`);
    }
    finally{
        //4. Close the database connection pool
        await pool.end();
        console.log('[Migration] Database connection pool closed.');

    }
};
runMigrations();