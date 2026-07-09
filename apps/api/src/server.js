//Day 1: Express server code 

import express from 'express';
import dotenv from 'dotenv';

//Day 2: PostgreSQL database connection pool code updating health check endpoint to include database connection status
import pool from './config/db.js';

//loading the environment variables
dotenv.config();


const app = express();
const PORT = process.env.PORT||5001;

app.use(express.json());

//foundation health check endpoints 
//async function to check the health of the foundation
app.get('/health', async(req, res) => {
    let dbStatus = 'DOWN';
    try{
        //Run a quick primitive query to test connectivity 
        await pool.query('SELECT 1');
        dbStatus = 'UP';

    } 
    catch(err){
        console.error(`[Health Check Error] Database connectivity failed: ${err.message}`);
    }
    
    res.status(200).json({
        status: "UP",
        // message: "Foundation is healthy",
        //day 2: Adding database connection status to the health check response
        services: {
            gateway: 'UP',
            database: dbStatus
        },
        timestamp: new Date().toISOString(),
        uptime: process.uptime()

    });
});

app.use((err, req, res, next) => {
    console.error(`[Server Error] ${err.message}`);
    res.status(500).json({
        error: 'Internal server error',
        message: err.message || 'An unexpected error occurred'
    });
});
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});