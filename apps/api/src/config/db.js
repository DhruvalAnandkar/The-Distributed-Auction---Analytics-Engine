//Day 2: Standard ES6 Connection pool logic.
// This is for the PostgreSQL database connection using the pg module



import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const {Pool} = pg;
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port : parseInt(process.env.DB_PORT || '5432', 10),
    // Interview point : pool configuration limits
    max:20, // -->Max number of clients in the pool
    idleTimeoutMillis: 30000, //-->How long a client is allowed to eremain idle before being closed
    connectionTimeoutMillis: 2000, //-->this tells us how longh to wait to connect before throwing an error message 
});
//logging the pool connections events for the observation of the pool connections
pool.on('connect',() =>{
    console.log('[Database] New client connected to postgreSQL pool');

});

pool.on('error',() =>{
    console.log('[Database] Error occurred in postgreSQL pool');

});

export const query = (text,params)=>{
    return pool.query(text,params);
};
export default pool;
