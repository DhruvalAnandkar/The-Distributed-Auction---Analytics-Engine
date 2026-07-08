import express from 'express';
import dotenv from 'dotenv';

//loading the environment variables
dotenv.config();


const app = express();
const PORT = process.env.PORT||5001;

app.use(express.json());

//foundation health check endpoints
app.get('/health', (req, res) => {
    res.status(200).json({
        status: "UP",
        message: "Foundation is healthy",
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