#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

class LogMigrator {
    constructor() {
        this.pool = new Pool({
            host: process.env.DB_HOST || 'localhost',
            port: parseInt(process.env.DB_PORT) || 5432,
            database: process.env.DB_NAME || 'trading_bot',
            user: process.env.DB_USER || 'trading_bot',
            password: process.env.DB_PASSWORD || 'secure_password',
        });
    }

    parseLogLine(line) {
        try {
            const match = line.match(/\[([^\]]+)\]\s+(.*)/);
            if (!match) return null;
            const [, timestamp, message] = match;
            let level = 'INFO';
            if (message.includes('[✓]') || message.includes('[OK]')) level = 'INFO';
            else if (message.includes('[✗]') || message.includes('[ERROR]')) level = 'ERROR';
            else if (message.includes('[⚠]') || message.includes('[WARN]')) level = 'WARN';
            else if (message.includes('[DEBUG]')) level = 'DEBUG';
            let service = 'SYSTEM';
            if (message.includes('[default]') || message.includes('[sber_bid]')) service = 'STRATEGY';
            else if (message.includes('[Engine]')) service = 'ENGINE';
            else if (message.includes('[WS]')) service = 'WS';
            else if (message.includes('[REST]')) service = 'REST';
            else if (message.includes('[Auth]')) service = 'AUTH';
            return { timestamp: new Date(timestamp), level, service, message: message.trim(), context: { raw: message } };
        } catch (e) { return null; }
    }

    async migrateLogFile(logFilePath) {
        console.log(`📂 Reading log file: ${logFilePath}`);
        if (!fs.existsSync(logFilePath)) {
            console.error(`❌ File not found: ${logFilePath}`);
            process.exit(1);
        }
        const fileStream = fs.createReadStream(logFilePath);
        const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
        let lineCount = 0, insertedCount = 0, batch = [];
        for await (const line of rl) {
            lineCount++;
            if (lineCount % 1000 === 0) console.log(`📊 Processed ${lineCount} lines...`);
            const logEntry = this.parseLogLine(line);
            if (logEntry) {
                batch.push(logEntry);
                if (batch.length >= 100) {
                    await this.insertBatch(batch);
                    insertedCount += batch.length;
                    batch.length = 0;
                }
            }
        }
        if (batch.length > 0) { await this.insertBatch(batch); insertedCount += batch.length; }
        console.log(`✅ Migration completed: ${insertedCount} records from ${lineCount} lines`);
        await this.pool.end();
    }

    async insertBatch(entries) {
        const query = `INSERT INTO logs (timestamp, level, service, message, context) VALUES ($1, $2, $3, $4, $5)`;
        for (const entry of entries) {
            try {
                await this.pool.query(query, [entry.timestamp, entry.level, entry.service, entry.message, JSON.stringify(entry.context || {})]);
            } catch (e) { console.error(`Failed to insert log: ${e.message}`); }
        }
    }
}

if (require.main === module) {
    const migrator = new LogMigrator();
    const logFile = process.argv[2] || path.join(__dirname, '../logs/bot_*.log');
    migrator.migrateLogFile(logFile).catch(console.error);
}
module.exports = LogMigrator;
