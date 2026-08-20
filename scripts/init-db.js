#!/usr/bin/env node
const { Pool } = require('pg');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

async function initDatabase() {
    console.log('📦 Initializing database...');
    
    const pool = new Pool({
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || 'trading_bot',
        user: process.env.DB_USER || 'trading_bot',
        password: process.env.DB_PASSWORD || 'secure_password',
    });

    try {
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        await pool.query(schema);
        console.log('✅ Database schema created successfully');
        
        const result = await pool.query('SELECT NOW() as time');
        console.log(`✅ Database connected at ${result.rows[0].time}`);
    } catch (error) {
        console.error('❌ Database initialization failed:', error.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

if (require.main === module) {
    initDatabase().catch(console.error);
}
module.exports = initDatabase;
