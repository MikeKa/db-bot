#!/bin/bash

# ============================================================
# TRADING BOT v4.0 - ПОЛНОЕ РАЗВЁРТЫВАНИЕ
# ============================================================
# Версия: 4.0.0
# Дата: 2026-08-19
# ============================================================
# ВКЛЮЧАЕТ:
# - Полную функциональность v3.0.1 (торговля, заявки, WS)
# - PostgreSQL для хранения данных
# - Глобальный стек для множества стратегий
# - Веб-интерфейс с вкладками для каждой стратегии
# - Поддержка нескольких стратегий одновременно
# ============================================================

echo "🚀 СОЗДАНИЕ TRADING BOT v4.0 (ПОЛНАЯ ВЕРСИЯ)"
echo "============================================================"

# Создаём структуру папок
mkdir -p src/core/order src/core/execution src/core/checker src/core/risk
mkdir -p src/strategies src/adapters src/services src/routes src/config src/utils
mkdir -p src/db src/public/css src/public/js
mkdir -p logs scripts

# ============================================================
# 1. PACKAGE.JSON
# ============================================================
cat > package.json << 'EOF'
{
  "name": "trading-bot",
  "version": "4.0.0",
  "description": "Trading bot with PostgreSQL and multi-strategy support",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "dev": "nodemon src/index.js",
    "db:init": "node scripts/init-db.js",
    "migrate-logs": "node scripts/migrate-logs.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "ws": "^8.14.2",
    "dotenv": "^16.3.1",
    "cors": "^2.8.5",
    "uuid": "^9.0.0",
    "pg": "^8.11.3"
  },
  "devDependencies": {
    "nodemon": "^3.0.1"
  }
}
EOF

# ============================================================
# 2. .ENV.EXAMPLE
# ============================================================
cat > .env.example << 'EOF'
# Server
PORT=3001
BASE_PATH=/bot

# BCS API
BCS_REFRESH_TOKEN=your_refresh_token_here
BASE_URL=https://be.broker.ru
WS_TRANSACTIONS_URL=wss://ws.broker.ru/trade-api-bff-operations/api/v1/orders/transaction/ws
WS_MARKET_URL=wss://ws.broker.ru/trade-api-market-data-connector/api/v1/market-data/ws

# WebSocket
WS_CONNECT_TIMEOUT=10000
WS_MAX_RECONNECT_ATTEMPTS=10
WS_RECONNECT_DELAY=1.0
WS_MAX_WAIT_TIME=3000

# Retry
RETRY_DELAY=1.0
MAX_RETRIES=10

# Bot
BOT_TOTAL_CYCLES=100
BOT_DELAY=0.05
POST_OPERATION_DELAY=0.1

# Logging
LOG_DISABLED=false
LOG_LEVEL=ALL
RECONCILE_INTERVAL=300000

# PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_NAME=trading_bot
DB_USER=trading_bot
DB_PASSWORD=secure_password
DB_POOL_SIZE=20
DB_IDLE_TIMEOUT=30000
DB_CONNECTION_TIMEOUT=5000
EOF

# ============================================================
# 3. .GITIGNORE
# ============================================================
cat > .gitignore << 'EOF'
node_modules/
logs/
.env
*.log
.DS_Store
*.pid
*.sqlite
*.db
EOF

# ============================================================
# 4. SCRIPTS/INIT-DB.JS
# ============================================================
cat > scripts/init-db.js << 'EOF'
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
EOF

# ============================================================
# 5. SCRIPTS/SCHEMA.SQL
# ============================================================
cat > scripts/schema.sql << 'EOF'
-- TRADING BOT v4.0 - POSTGRESQL SCHEMA

CREATE TABLE IF NOT EXISTS strategies (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(50) NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    class_code VARCHAR(20) NOT NULL,
    config JSONB NOT NULL DEFAULT '{}',
    status VARCHAR(20) DEFAULT 'INACTIVE',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_started_at TIMESTAMP WITH TIME ZONE,
    last_stopped_at TIMESTAMP WITH TIME ZONE,
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_strategies_symbol ON strategies(symbol);
CREATE INDEX IF NOT EXISTS idx_strategies_status ON strategies(status);

CREATE TABLE IF NOT EXISTS instruments (
    id SERIAL PRIMARY KEY,
    ticker VARCHAR(20) NOT NULL UNIQUE,
    class_code VARCHAR(20) NOT NULL,
    name VARCHAR(100),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS orders (
    id BIGSERIAL PRIMARY KEY,
    client_order_id VARCHAR(100) NOT NULL UNIQUE,
    broker_order_id VARCHAR(100),
    strategy_id VARCHAR(50) REFERENCES strategies(id) ON DELETE SET NULL,
    instrument_id INTEGER REFERENCES instruments(id) ON DELETE SET NULL,
    side VARCHAR(10) NOT NULL,
    order_type VARCHAR(20) NOT NULL DEFAULT 'LIMIT',
    price DECIMAL(20, 8),
    quantity DECIMAL(20, 8) NOT NULL,
    filled_quantity DECIMAL(20, 8) DEFAULT 0,
    remaining_quantity DECIMAL(20, 8),
    status VARCHAR(30) NOT NULL,
    broker_status VARCHAR(10),
    error_message TEXT,
    linked_order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
    replaces_order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
    replaced_by_order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
    role VARCHAR(20),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    confirmed_at TIMESTAMP WITH TIME ZONE,
    filled_at TIMESTAMP WITH TIME ZONE,
    cancelled_at TIMESTAMP WITH TIME ZONE,
    expired_at TIMESTAMP WITH TIME ZONE,
    broker_order_number BIGINT,
    broker_client_code VARCHAR(50),
    broker_execution_id VARCHAR(100),
    broker_transaction_time TIMESTAMP WITH TIME ZONE,
    metadata JSONB DEFAULT '{}',
    raw_broker_response JSONB,
    version INTEGER DEFAULT 1,
    attempts INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    is_ws_confirmed BOOLEAN DEFAULT FALSE,
    is_rest_confirmed BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_orders_client_order_id ON orders(client_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_broker_order_id ON orders(broker_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_strategy_id ON orders(strategy_id);
CREATE INDEX IF NOT EXISTS idx_orders_instrument_id ON orders(instrument_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_is_active ON orders(is_active);

CREATE TABLE IF NOT EXISTS order_status_history (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT REFERENCES orders(id) ON DELETE CASCADE,
    status VARCHAR(30) NOT NULL,
    broker_status VARCHAR(10),
    price DECIMAL(20, 8),
    quantity DECIMAL(20, 8),
    filled_quantity DECIMAL(20, 8),
    remaining_quantity DECIMAL(20, 8),
    error_message TEXT,
    raw_data JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    source VARCHAR(20)
);

CREATE INDEX IF NOT EXISTS idx_order_status_history_order_id ON order_status_history(order_id);

CREATE TABLE IF NOT EXISTS logs (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    level VARCHAR(10) NOT NULL,
    service VARCHAR(50),
    strategy_id VARCHAR(50) REFERENCES strategies(id) ON DELETE SET NULL,
    order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
    message TEXT NOT NULL,
    context JSONB,
    source_file VARCHAR(200),
    source_line INTEGER,
    trace_id VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
CREATE INDEX IF NOT EXISTS idx_logs_strategy_id ON logs(strategy_id);
CREATE INDEX IF NOT EXISTS idx_logs_order_id ON logs(order_id);

INSERT INTO strategies (id, name, type, symbol, class_code, config, status)
VALUES 
    ('sber_bid', 'SBER BID Strategy', 'constant-bid', 'SBER', 'TQBR', '{"offsetPercent": 1, "quantity": 1}', 'INACTIVE')
ON CONFLICT (id) DO NOTHING;

INSERT INTO instruments (ticker, class_code, name, is_active)
VALUES 
    ('SBER', 'TQBR', 'Сбербанк', true)
ON CONFLICT (ticker) DO NOTHING;
EOF

# ============================================================
# 6. SCRIPTS/MIGRATE-LOGS.JS
# ============================================================
cat > scripts/migrate-logs.js << 'EOF'
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
EOF

# ============================================================
# 7. SRC/INDEX.JS
# ============================================================
cat > src/index.js << 'EOF'
const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const apiRoutes = require('./routes/api');
const logger = require('./utils/logger');
const db = require('./db');
const initializer = require('./services/initializer');

console.log('='.repeat(60));
console.log('📊 LOGGING CONFIGURATION');
console.log('='.repeat(60));
console.log(`   Level: ${logger.getLevelName()}`);
console.log(`   Disabled: ${logger.getStatus().disabled}`);
console.log(`   Log file: ${logger.getStatus().logFile}`);
console.log('='.repeat(60));

const app = express();
const port = config.port;
const basePath = config.basePath;

app.use(cors());
app.use(express.json());
app.use(`${basePath}`, express.static(path.join(__dirname, 'public')));
app.use(`${basePath}/api`, apiRoutes);

app.get(`${basePath}/health`, (req, res) => {
    const status = initializer.getStatus ? initializer.getStatus() : {};
    res.json({
        status: 'ok',
        version: '4.0.0',
        initialized: initializer.initialized || false,
        isHealthy: initializer.isHealthy ? initializer.isHealthy() : false,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        strategies: status.strategies || { total: 0, active: 0 }
    });
});

app.get(`${basePath}/`, (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Not Found', path: req.path });
});

app.use((err, req, res, next) => {
    console.error('[Server] ❌ Error:', err.message);
    console.error(err.stack);
    res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
});

let server = null;
let isShuttingDown = false;

async function startServer() {
    try {
        await initializer.initialize();
    } catch (error) {
        logger.err(`❌ Initialization error: ${error.message}`);
        logger.warn('⚠️ Server will start but bot may not work properly');
    }

    server = app.listen(port, '0.0.0.0', () => {
        const status = initializer.getStatus ? initializer.getStatus() : {};
        console.log('='.repeat(60));
        console.log('🤖 TRADING BOT v4.0');
        console.log('='.repeat(60));
        console.log(`📡 Server: http://localhost:${port}${basePath}`);
        console.log(`❤️  Health: http://localhost:${port}${basePath}/health`);
        console.log('');
        console.log(`🎯 Status: ${initializer.isHealthy ? (initializer.isHealthy() ? '✅ HEALTHY' : '⚠️ DEGRADED') : '❓ UNKNOWN'}`);
        console.log(`📊 Strategies: ${status.strategies?.total || 0} total, ${status.strategies?.active || 0} active`);
        console.log(`📊 Logging: ${logger.getLevelName()}`);
        console.log('='.repeat(60));
        console.log('Press Ctrl+C to stop');
        console.log('='.repeat(60));
    });
}

async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n🛑 Received ${signal}, starting graceful shutdown...`);
    const forceExitTimeout = setTimeout(() => { console.error('❌ Shutdown timeout, forcing exit...'); process.exit(1); }, 15000);
    try {
        console.log('⏹️ Stopping bot...');
        initializer.stopBot();
        console.log('🔌 Closing HTTP server...');
        if (server) { await new Promise((resolve, reject) => { server.close((err) => { if (err) reject(err); else resolve(); }); }); }
        console.log('🔌 Disconnecting from database...');
        await db.disconnect();
        console.log('📝 Closing logs...');
        if (logger.logStream) logger.logStream.end();
        clearTimeout(forceExitTimeout);
        console.log('✅ Graceful shutdown completed');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error during graceful shutdown:', error.message);
        clearTimeout(forceExitTimeout);
        process.exit(1);
    }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', async (err) => { console.error('❌ Uncaught Exception:', err); await gracefulShutdown('uncaughtException'); });
process.on('unhandledRejection', async (reason) => { console.error('❌ Unhandled Rejection:', reason); await gracefulShutdown('unhandledRejection'); });

console.log('='.repeat(60));
console.log('🚀 Starting Trading Bot v4.0...');
console.log('='.repeat(60));

startServer().catch((error) => {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
});
EOF

# ============================================================
# 8. SRC/CONFIG/INDEX.JS
# ============================================================
cat > src/config/index.js << 'EOF'
const dotenv = require('dotenv');
dotenv.config();

module.exports = {
    port: parseInt(process.env.PORT) || 3001,
    basePath: process.env.BASE_PATH || '/bot',
    refreshToken: process.env.BCS_REFRESH_TOKEN,
    baseUrl: process.env.BASE_URL || 'https://be.broker.ru',
    wsTransactionsUrl: process.env.WS_TRANSACTIONS_URL ||
        'wss://ws.broker.ru/trade-api-bff-operations/api/v1/orders/transaction/ws',
    wsMarketUrl: process.env.WS_MARKET_URL ||
        'wss://ws.broker.ru/trade-api-market-data-connector/api/v1/market-data/ws',
    wsConnectTimeout: parseInt(process.env.WS_CONNECT_TIMEOUT) || 10000,
    wsMaxReconnectAttempts: parseInt(process.env.WS_MAX_RECONNECT_ATTEMPTS) || 10,
    wsReconnectDelay: parseFloat(process.env.WS_RECONNECT_DELAY) || 1.0,
    wsMaxWaitTime: parseInt(process.env.WS_MAX_WAIT_TIME) || 3000,
    retryDelay: parseFloat(process.env.RETRY_DELAY) || 1.0,
    maxRetries: parseInt(process.env.MAX_RETRIES) || 10,
    totalCycles: parseInt(process.env.BOT_TOTAL_CYCLES) || 100,
    botDelay: parseFloat(process.env.BOT_DELAY) || 0.05,
    postOperationDelay: parseFloat(process.env.POST_OPERATION_DELAY) || 0.1,
    logDisabled: process.env.LOG_DISABLED === 'true',
    logLevel: process.env.LOG_LEVEL || 'ALL',
    reconcileInterval: parseInt(process.env.RECONCILE_INTERVAL) || 300000,
    db: {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || 'trading_bot',
        user: process.env.DB_USER || 'trading_bot',
        password: process.env.DB_PASSWORD,
        poolSize: parseInt(process.env.DB_POOL_SIZE) || 20,
        idleTimeout: parseInt(process.env.DB_IDLE_TIMEOUT) || 30000,
        connectionTimeout: parseInt(process.env.DB_CONNECTION_TIMEOUT) || 5000,
    }
};
EOF

# ============================================================
# 9. SRC/CONFIG/STRATEGY.JS
# ============================================================
cat > src/config/strategy.js << 'EOF'
module.exports = {
    instrument: {
        ticker: 'SBER',
        classCode: 'TQBR',
    },
    strategy: {
        type: 'constant-bid',
        quantity: 1,
        offsetPercent: 1,
        side: 'BUY',
        modifyThreshold: 0.05,
        minPrice: 0,
        maxPrice: 300,
    },
    orderQuantity: 1,
    priceOffsetPercent: 1,
    modifyOffsetPercent: 1.5,
    modifyThreshold: 0.05,
    forceModify: false,
};
EOF

# ============================================================
# 10. SRC/UTILS/LOGGER.JS
# ============================================================
cat > src/utils/logger.js << 'EOF'
const fs = require('fs');
const path = require('path');
const config = require('../config');

const LOG_DIR = path.join(__dirname, '../../logs');
try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o755 });
    try { fs.accessSync(LOG_DIR, fs.constants.W_OK); } catch (err) { fs.chmodSync(LOG_DIR, 0o755); }
} catch (err) { console.error(`[Logger] Failed to create log directory: ${err.message}`); }

const LOG_FILE = path.join(LOG_DIR, `bot_${new Date().toISOString().replace(/[:.]/g, '').slice(0, 14)}.log`);
let logStream;
try { logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' }); } catch (err) { logStream = process.stdout; }

const logHistory = [];
const MAX_LOG_HISTORY = 200;

const COLORS = {
    green: '\x1b[0;32m', red: '\x1b[0;31m', blue: '\x1b[0;34m',
    yellow: '\x1b[1;33m', cyan: '\x1b[0;36m', magenta: '\x1b[0;35m',
    gray: '\x1b[0;90m', white: '\x1b[0;37m', nc: '\x1b[0m',
};

const LOG_LEVELS = { NONE: 0, ERROR: 1, WARN: 2, INFO: 3, LOG: 4, DEBUG: 5, ALL: 6 };
let currentLevel = LOG_LEVELS[config.logLevel] || LOG_LEVELS.ALL;
let disabled = config.logDisabled || false;
let disableWsLogs = false, disableStats = false;

function shouldLog(level) { return !disabled && currentLevel >= level; }
function logToFile(msg) { try { logStream.write(`[${new Date().toISOString()}] ${msg}\n`); } catch (err) {} }
function addToHistory(level, msg) { logHistory.push({ timestamp: new Date(), level, message: msg }); if (logHistory.length > MAX_LOG_HISTORY) logHistory.shift(); }
function getLogs(limit = 50) { return logHistory.slice(-limit); }

function setLevel(level) {
    const upper = level.toUpperCase();
    if (LOG_LEVELS[upper] !== undefined) { currentLevel = LOG_LEVELS[upper]; console.log(`📊 Log level set to: ${upper}`); logToFile(`[CONFIG] Log level set to: ${upper}`); }
}
function getLevel() { return currentLevel; }
function getLevelName() { return Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k] === currentLevel) || 'UNKNOWN'; }
function disableAll() { disabled = true; console.log('🔇 All logging disabled'); }
function enableAll() { disabled = false; console.log('🔊 All logging enabled'); }
function setWsLogsDisabled(state) { disableWsLogs = state; }
function setStatsDisabled(state) { disableStats = state; }
function getStatus() { return { disabled, level: currentLevel, levelName: getLevelName(), disableWsLogs, disableStats, logFile: LOG_FILE, historySize: logHistory.length }; }

function log(msg) { if (!shouldLog(LOG_LEVELS.LOG)) return; console.log(`${COLORS.blue}[${new Date().toTimeString().slice(0, 8)}]${COLORS.nc} ${msg}`); logToFile(msg); addToHistory('LOG', msg); }
function ok(msg) { if (!shouldLog(LOG_LEVELS.INFO)) return; console.log(`${COLORS.green}[✓]${COLORS.nc} ${msg}`); logToFile(`[OK] ${msg}`); addToHistory('INFO', msg); }
function err(msg) { if (!shouldLog(LOG_LEVELS.ERROR)) return; console.log(`${COLORS.red}[✗]${COLORS.nc} ${msg}`); logToFile(`[ERROR] ${msg}`); addToHistory('ERROR', msg); }
function info(msg) { if (!shouldLog(LOG_LEVELS.INFO)) return; console.log(`${COLORS.yellow}[i]${COLORS.nc} ${msg}`); logToFile(`[INFO] ${msg}`); addToHistory('INFO', msg); }
function warn(msg) { if (!shouldLog(LOG_LEVELS.WARN)) return; console.log(`${COLORS.magenta}[⚠]${COLORS.nc} ${msg}`); logToFile(`[WARN] ${msg}`); addToHistory('WARN', msg); }
function stat(msg) { if (!shouldLog(LOG_LEVELS.INFO) || disableStats) return; console.log(`${COLORS.cyan}[📊]${COLORS.nc} ${msg}`); logToFile(`[STAT] ${msg}`); addToHistory('STAT', msg); }
function wsLog(msg) { if (!shouldLog(LOG_LEVELS.DEBUG) || disableWsLogs) return; console.log(`${COLORS.gray}[WS]${COLORS.nc} ${msg}`); logToFile(`[WS] ${msg}`); addToHistory('DEBUG', msg); }
function debug(msg) { if (!shouldLog(LOG_LEVELS.DEBUG)) return; console.log(`${COLORS.gray}[DEBUG]${COLORS.nc} ${msg}`); logToFile(`[DEBUG] ${msg}`); addToHistory('DEBUG', msg); }

module.exports = {
    log, ok, err, info, warn, stat, wsLog, debug,
    logToFile, logStream, logHistory, getLogs,
    setLevel, getLevel, getLevelName, disableAll, enableAll,
    setWsLogsDisabled, setStatsDisabled, getStatus, LOG_LEVELS
};
EOF

# ============================================================
# 11. SRC/UTILS/ORDER-ID.JS
# ============================================================
cat > src/utils/order-id.js << 'EOF'
const crypto = require('crypto');

class OrderIdGenerator {
    static generate(strategyId, instrument, side, role, timestamp = Date.now()) {
        const uuid = crypto.randomUUID().slice(0, 8);
        return `${strategyId}_${instrument}_${side}_${role}_${timestamp}_${uuid}`;
    }

    static parse(clientOrderId) {
        if (!clientOrderId) return null;
        const parts = clientOrderId.split('_');
        if (parts.length < 6) return null;
        return {
            strategyId: parts[0],
            instrument: parts[1],
            side: parts[2],
            role: parts[3],
            timestamp: parseInt(parts[4]),
            uuid: parts[5],
            fullId: clientOrderId
        };
    }

    static isStructured(clientOrderId) {
        return this.parse(clientOrderId) !== null;
    }

    static getStrategyId(clientOrderId) {
        const parsed = this.parse(clientOrderId);
        return parsed ? parsed.strategyId : null;
    }
}

module.exports = OrderIdGenerator;
EOF

# ============================================================
# 12. SRC/CORE/INTERFACES.JS
# ============================================================
cat > src/core/interfaces.js << 'EOF'
const { v4: uuidv4 } = require('uuid');

class TradeIntent {
    constructor(params) {
        this.strategyId = params.strategyId || 'default';
        this.symbol = params.symbol || 'SBER';
        this.action = params.action || 'CREATE';
        this.side = params.side || 'BUY';
        this.price = params.price || 0;
        this.quantity = params.quantity || 1;
        this.orderType = params.orderType || 'LIMIT';
        this.intentId = params.intentId || `${this.strategyId}_${Date.now()}_${uuidv4().slice(0, 8)}`;
        this.timestamp = new Date();
        this.metadata = params.metadata || {};
        this.orderId = params.orderId || null;
        this.classCode = params.classCode || 'TQBR';
    }
    isCreate() { return this.action === 'CREATE'; }
    isModify() { return this.action === 'MODIFY'; }
    isCancel() { return this.action === 'CANCEL'; }
    toJSON() { return { strategyId: this.strategyId, symbol: this.symbol, action: this.action, side: this.side, price: this.price, quantity: this.quantity, orderType: this.orderType, intentId: this.intentId, timestamp: this.timestamp, metadata: this.metadata, orderId: this.orderId, classCode: this.classCode }; }
}

class ExecutionRequest {
    constructor(params) {
        this.requestId = uuidv4();
        this.intentId = params.intentId || null;
        this.strategyId = params.strategyId || 'default';
        this.action = params.action || 'CREATE';
        this.symbol = params.symbol || 'SBER';
        this.classCode = params.classCode || 'TQBR';
        this.side = params.side || 'BUY';
        this.price = params.price || 0;
        this.quantity = params.quantity || 1;
        this.orderType = params.orderType || 'LIMIT';
        let clientOrderId = params.clientOrderId || uuidv4();
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(clientOrderId)) clientOrderId = uuidv4();
        this.clientOrderId = clientOrderId;
        this.orderId = params.orderId || null;
        this.timestamp = new Date();
        this.enqueuedAt = null;
        this.idempotencyKey = `${params.strategyId || 'default'}_${this.clientOrderId}`;
        this.metadata = params.metadata || {};
        this.riskApproved = params.riskApproved || false;
        this.riskMetadata = params.riskMetadata || {};
    }
    toJSON() { return { requestId: this.requestId, intentId: this.intentId, strategyId: this.strategyId, action: this.action, symbol: this.symbol, classCode: this.classCode, side: this.side, price: this.price, quantity: this.quantity, orderType: this.orderType, clientOrderId: this.clientOrderId, orderId: this.orderId, timestamp: this.timestamp, enqueuedAt: this.enqueuedAt, idempotencyKey: this.idempotencyKey, riskApproved: this.riskApproved }; }
}

class ExecutionResult {
    constructor(params) {
        this.requestId = params.requestId || null;
        this.clientOrderId = params.clientOrderId || null;
        this.brokerOrderId = params.brokerOrderId || null;
        this.success = params.success || false;
        this.status = params.status || 'PENDING';
        this.source = params.source || 'unknown';
        this.error = params.error || null;
        this.data = params.data || null;
        this.timestamp = new Date();
        this.confirmedAt = null;
        this.attempts = params.attempts || 0;
    }
}

class OrderStatusEvent {
    constructor(params) {
        this.clientOrderId = params.clientOrderId || null;
        this.orderId = params.orderId || null;
        this.strategyId = params.strategyId || null;
        this.status = params.status || 'UNKNOWN';
        this.price = params.price || 0;
        this.quantity = params.quantity || 0;
        this.filledQuantity = params.filledQuantity || 0;
        this.remainingQuantity = params.remainingQuantity || 0;
        this.timestamp = new Date();
        this.raw = params.raw || null;
    }
    isFinal() { return ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'ERROR'].includes(this.status); }
    isActive() { return ['CREATED', 'MODIFIED', 'PARTIALLY_FILLED', 'PENDING'].includes(this.status); }
}

module.exports = { TradeIntent, ExecutionRequest, ExecutionResult, OrderStatusEvent };
EOF

# ============================================================
# 13. SRC/CORE/ORDER/ORDER-STACK.JS
# ============================================================
cat > src/core/order/order-stack.js << 'EOF'
const EventEmitter = require('events');
const logger = require('../../utils/logger');

class OrderStack extends EventEmitter {
    constructor(strategyId, options = {}) {
        super();
        this.strategyId = strategyId;
        this.orders = new Map();
        this.pendingConfirmations = new Map();
        this.history = [];
        this.maxHistorySize = options.maxHistorySize || 1000;
        this.reconcileInterval = options.reconcileInterval || 300000;
        this._reconcileTimer = null;
        this._isReconciling = false;
        this._initialized = false;
        this.pendingTimeout = options.pendingTimeout || 15000;
        this._cleanupTimer = null;
        this._isWsSynced = true;
        this._lastWsSyncTime = 0;
        this._pendingSyncOrders = new Map();
        this._pendingWsConfirmations = new Map();
    }

    isFinalStatus(status) {
        const finalStatuses = ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED', '2', '4', '7', '9'];
        return finalStatuses.includes(String(status));
    }

    isActiveStatus(status) {
        const activeStatuses = ['CREATED', 'MODIFIED', 'PARTIALLY_FILLED', 'PENDING', 'ACTIVE', '0', '1', '3', '5'];
        return activeStatuses.includes(String(status));
    }

    isReplacedStatus(status) {
        const replacedStatuses = ['REPLACED', '5'];
        return replacedStatuses.includes(String(status));
    }

    async initialize(brokerAdapter) {
        if (this._initialized) return;
        logger.info(`[${this.strategyId}] Initializing order stack...`);
        try {
            const activeOrders = await brokerAdapter.syncOrdersByList({ strategyId: this.strategyId });
            this.orders.clear();
            let loadedCount = 0;
            for (const order of activeOrders) {
                const activeStatuses = ['0', '1', '3', '5'];
                if (!activeStatuses.includes(order.orderStatus)) {
                    logger.debug(`[${this.strategyId}] Skipping order: ${order.clientOrderId} (status: ${order.orderStatus})`);
                    continue;
                }
                if (order.orderStatus === '9') {
                    logger.debug(`[${this.strategyId}] Skipping REPLACING order: ${order.clientOrderId} (status: 9)`);
                    continue;
                }
                this.orders.set(order.clientOrderId, order);
                loadedCount++;
                logger.info(`[${this.strategyId}] Loaded active order: ${order.clientOrderId} (status: ${order.orderStatus})`);
            }
            this._initialized = true;
            this._lastWsSyncTime = Date.now();
            this._isWsSynced = true;
            logger.ok(`[${this.strategyId}] Loaded ${loadedCount} active orders`);
            this.startReconcile(brokerAdapter);
            this.startCleanup();
        } catch (e) {
            logger.err(`[${this.strategyId}] Failed to initialize: ${e.message}`);
            throw e;
        }
    }

    addPending(order) {
        this.pendingConfirmations.set(order.clientOrderId, {
            order, timestamp: Date.now(), attempts: 0,
            replacesOrderId: order.replaces || null,
            brokerOrderId: order.brokerOrderId || null,
        });
        this.markWsUnsynced(order.clientOrderId, 'CREATE');
        logger.info(`[${this.strategyId}] Order ${order.clientOrderId} pending confirmation`);
        this.emit('pending_added', order);
        setTimeout(() => {
            if (this.pendingConfirmations.has(order.clientOrderId)) {
                const pending = this.pendingConfirmations.get(order.clientOrderId);
                if (Date.now() - pending.timestamp > this.pendingTimeout) {
                    logger.warn(`[${this.strategyId}] Pending timeout for ${order.clientOrderId}`);
                    this.pendingConfirmations.delete(order.clientOrderId);
                    this._pendingSyncOrders.delete(order.clientOrderId);
                    this.emit('pending_timeout', order);
                }
            }
        }, this.pendingTimeout);
    }

    confirm(clientOrderId, status, data = null) {
        const pending = this.pendingConfirmations.get(clientOrderId);
        if (!pending) { logger.warn(`[${this.strategyId}] Confirmation for unknown order: ${clientOrderId}`); return false; }
        const order = pending.order;
        order.status = status;
        order.confirmedAt = new Date();
        order.responseData = data;
        order.wsConfirmed = true;
        order.lastUpdate = new Date();
        let brokerOrderId = data?.orderId || data?.data?.orderId || null;
        if (brokerOrderId) { order.brokerOrderId = brokerOrderId; order.orderId = brokerOrderId; }
        this._pendingWsConfirmations.set(clientOrderId, { confirmed: true, status, timestamp: Date.now() });
        const isFinal = this.isFinalStatus(status);
        const isReplaced = status === '5' || status === 'REPLACED';
        if (isReplaced) {
            const oldOrderId = order.replaces || order.originalOrderId || null;
            if (oldOrderId && this.orders.has(oldOrderId)) {
                const oldOrder = this.orders.get(oldOrderId);
                oldOrder.status = 'REPLACING';
                oldOrder.replacedBy = clientOrderId;
                oldOrder.isActive = false;
                oldOrder.lastUpdate = new Date();
                oldOrder.wsConfirmed = true;
                this.addToHistory(oldOrder);
                this.orders.delete(oldOrderId);
                logger.info(`[${this.strategyId}] Removed old order: ${oldOrderId} → ${clientOrderId}`);
            }
            if (oldOrderId && this.pendingConfirmations.has(oldOrderId)) {
                this.pendingConfirmations.delete(oldOrderId);
                this._pendingSyncOrders.delete(oldOrderId);
            }
        }
        if (isFinal && !isReplaced) {
            this.orders.delete(clientOrderId);
            this.addToHistory(order);
            logger.ok(`[${this.strategyId}] Order ${clientOrderId} closed: ${status}`);
            this.emit('order_closed', order);
        } else {
            this.orders.set(clientOrderId, order);
            logger.ok(`[${this.strategyId}] Order ${clientOrderId} confirmed: ${status}`);
            this.emit('order_confirmed', order);
        }
        this.pendingConfirmations.delete(clientOrderId);
        this._pendingSyncOrders.delete(clientOrderId);
        this.markWsSynced();
        return true;
    }

    markWsSynced() { this._isWsSynced = true; this._lastWsSyncTime = Date.now(); }
    markWsUnsynced(orderId, action) { this._isWsSynced = false; this._pendingSyncOrders.set(orderId, { action, timestamp: Date.now(), attempts: 0 }); }
    isPending(clientOrderId) { return this.pendingConfirmations.has(clientOrderId); }
    getPendingOrders() { return Array.from(this.pendingConfirmations.values()).map(p => p.order); }

    syncWithWs(event) {
        const { clientOrderId, status } = event;
        if (!clientOrderId) { logger.warn(`[${this.strategyId}] WS event without clientOrderId`); return; }
        logger.debug(`[${this.strategyId}] WS event: ${clientOrderId} status=${status}`);
        const brokerOrderId = event?.orderId || event?.data?.orderId || null;

        if (status === '9' || status === 'REPLACING') {
            logger.info(`[${this.strategyId}] Order ${clientOrderId} is REPLACING - old order`);
            if (this.orders.has(clientOrderId)) {
                const order = this.orders.get(clientOrderId);
                order.status = 'REPLACING';
                order.isActive = false;
                order.lastUpdate = new Date();
                order.wsConfirmed = true;
                this.addToHistory(order);
                this.orders.delete(clientOrderId);
            }
            if (this.pendingConfirmations.has(clientOrderId)) {
                this.pendingConfirmations.delete(clientOrderId);
                this._pendingSyncOrders.delete(clientOrderId);
            }
            this.markWsSynced();
            return;
        }

        if (status === '5' || status === 'REPLACED') {
            logger.info(`[${this.strategyId}] Order ${clientOrderId} is REPLACED - new active order`);
            const oldOrderId = event.originalClientOrderId || event.data?.originalClientOrderId || null;
            if (oldOrderId) {
                if (this.orders.has(oldOrderId)) {
                    const oldOrder = this.orders.get(oldOrderId);
                    oldOrder.status = 'REPLACING';
                    oldOrder.replacedBy = clientOrderId;
                    oldOrder.isActive = false;
                    oldOrder.lastUpdate = new Date();
                    oldOrder.wsConfirmed = true;
                    this.addToHistory(oldOrder);
                    this.orders.delete(oldOrderId);
                }
                if (this.pendingConfirmations.has(oldOrderId)) {
                    this.pendingConfirmations.delete(oldOrderId);
                    this._pendingSyncOrders.delete(oldOrderId);
                }
            }
            if (this.pendingConfirmations.has(clientOrderId)) {
                if (brokerOrderId) {
                    const pending = this.pendingConfirmations.get(clientOrderId);
                    if (pending) {
                        pending.order.brokerOrderId = brokerOrderId;
                        pending.order.orderId = brokerOrderId;
                        if (oldOrderId) { pending.order.replaces = oldOrderId; pending.order.originalOrderId = oldOrderId; }
                    }
                }
                this.confirm(clientOrderId, status, event);
            } else if (this.orders.has(clientOrderId)) {
                this.updateOrder(clientOrderId, event);
            } else {
                logger.warn(`[${this.strategyId}] Unknown REPLACED order from WS: ${clientOrderId}`);
                this.emit('unknown_order', event);
            }
            this.markWsSynced();
            return;
        }

        if (this.pendingConfirmations.has(clientOrderId)) {
            const pending = this.pendingConfirmations.get(clientOrderId);
            const pendingOrder = pending.order;
            if (pendingOrder.status === 'PENDING_CANCEL') {
                const originalOrderId = pendingOrder.originalOrderId;
                if (originalOrderId && this.orders.has(originalOrderId)) {
                    const originalOrder = this.orders.get(originalOrderId);
                    originalOrder.status = status || 'CANCELLED';
                    originalOrder.cancelledAt = new Date();
                    originalOrder.responseData = event;
                    originalOrder.wsConfirmed = true;
                    this.addToHistory(originalOrder);
                    this.orders.delete(originalOrderId);
                    logger.ok(`[${this.strategyId}] Order ${originalOrderId} cancelled via WS`);
                    this.emit('order_cancelled', originalOrder);
                }
                this.pendingConfirmations.delete(clientOrderId);
                this._pendingSyncOrders.delete(clientOrderId);
                this.markWsSynced();
                return;
            }
            if (status === 'ERROR' || status === '8' || status === 'REJECTED' || status === '7') {
                const order = pending.order;
                logger.err(`[${this.strategyId}] Order ${clientOrderId} failed with ${status}`);
                order.status = status;
                order.error = event;
                order.lastUpdate = new Date();
                order.attempts = (order.attempts || 0) + 1;
                order.wsConfirmed = true;
                if (brokerOrderId) { order.brokerOrderId = brokerOrderId; order.orderId = brokerOrderId; }
                if (!this.orders.has(clientOrderId)) this.orders.set(clientOrderId, order);
                this.pendingConfirmations.delete(clientOrderId);
                this._pendingSyncOrders.delete(clientOrderId);
                this.markWsSynced();
                if (order.attempts >= 3) {
                    this.emergencyStopStrategy(`Order ${clientOrderId} failed after ${order.attempts} attempts`, {
                        order: { clientOrderId: order.clientOrderId, price: order.price, quantity: order.quantity, status: order.status, attempts: order.attempts, createdAt: order.createdAt },
                        lastEvent: event, stackSize: this.orders.size, pendingSize: this.pendingConfirmations.size
                    });
                    return;
                }
                this.emit('order_error', { clientOrderId, event, order });
                return;
            }
            if (brokerOrderId) { pendingOrder.brokerOrderId = brokerOrderId; pendingOrder.orderId = brokerOrderId; }
            if (this.isReplacedStatus(status)) {
                const replacesOrderId = pendingOrder.replaces || pendingOrder.originalOrderId;
                if (replacesOrderId && this.orders.has(replacesOrderId)) {
                    const oldOrder = this.orders.get(replacesOrderId);
                    oldOrder.status = 'REPLACED';
                    oldOrder.replacedBy = clientOrderId;
                    if (brokerOrderId) { oldOrder.brokerOrderId = brokerOrderId; oldOrder.orderId = brokerOrderId; }
                    oldOrder.lastUpdate = new Date();
                    oldOrder.wsConfirmed = true;
                    this.addToHistory(oldOrder);
                    this.orders.delete(replacesOrderId);
                }
            }
            this.confirm(clientOrderId, status, event);
            return;
        }

        if (this.orders.has(clientOrderId)) {
            this.updateOrder(clientOrderId, event);
            this.markWsSynced();
            return;
        }
    }

    updateOrder(clientOrderId, event) {
        const order = this.orders.get(clientOrderId);
        if (!order) return;
        const oldStatus = order.status;
        order.status = event.status;
        order.lastUpdate = new Date();
        let brokerOrderId = event?.orderId || event?.data?.orderId || null;
        if (brokerOrderId) { order.brokerOrderId = brokerOrderId; order.orderId = brokerOrderId; }
        if (event.price) order.price = event.price;
        if (event.filledQuantity) {
            order.filledQuantity = (order.filledQuantity || 0) + event.filledQuantity;
            order.remainingQuantity = order.quantity - order.filledQuantity;
        }
        if (order.remainingQuantity <= 0 && order.status === 'FILLED') {
            this.orders.delete(clientOrderId);
            this.addToHistory(order);
            this.emit('order_filled', order);
            return;
        }
        if (['CANCELLED', 'EXPIRED'].includes(order.status)) {
            this.orders.delete(clientOrderId);
            this.addToHistory(order);
            this.emit('order_closed', order);
            return;
        }
        if (['ERROR', 'REJECTED'].includes(order.status)) {
            order.attempts = (order.attempts || 0) + 1;
            if (order.attempts >= 3) {
                this.emergencyStopStrategy(`Order ${clientOrderId} failed after ${order.attempts} attempts`, {
                    order: { clientOrderId: order.clientOrderId, price: order.price, quantity: order.quantity, status: order.status, attempts: order.attempts, createdAt: order.createdAt },
                    lastEvent: event, stackSize: this.orders.size, pendingSize: this.pendingConfirmations.size
                });
                return;
            }
            this.emit('order_invalid', { clientOrderId, status: order.status, attempts: order.attempts });
            return;
        }
        this.emit('order_updated', order);
    }

    emergencyStopStrategy(reason, context) {
        logger.err(`[${this.strategyId}] 🚨 EMERGENCY STOP: ${reason}`);
        this.emit('emergency_stop', { strategyId: this.strategyId, reason, context, timestamp: new Date().toISOString() });
        this._initialized = false;
        this.stopReconcile();
        this.stopCleanup();
    }

    canModifyOrder(clientOrderId) {
        const order = this.orders.get(clientOrderId);
        if (!order) return false;
        if (this.isPending(clientOrderId)) return false;
        const cannotModifyStatuses = ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED', '2', '4', '7', '9'];
        if (cannotModifyStatuses.includes(String(order.status))) return false;
        if (['ERROR', 'REJECTED'].includes(order.status) && (order.attempts || 0) >= 3) return false;
        if (!order.brokerOrderId || order.brokerOrderId === order.clientOrderId) return false;
        return true;
    }

    getOrderForModify(clientOrderId) {
        if (!this.canModifyOrder(clientOrderId)) return null;
        return this.orders.get(clientOrderId);
    }

    getActiveOrders() {
        const result = [];
        for (const [id, order] of this.orders) {
            if (String(order.status) === '9' || String(order.status) === 'REPLACING') continue;
            if (this.isActiveStatus(order.status) || order.status === 'ERROR' || order.status === 'REJECTED') {
                result.push(order);
            }
        }
        return result;
    }

    getValidActiveOrders() {
        const result = [];
        for (const [id, order] of this.orders) {
            if (String(order.status) === '9' || String(order.status) === 'REPLACING') continue;
            if (this.isActiveStatus(order.status)) result.push(order);
        }
        return result;
    }

    getOrder(clientOrderId) { return this.orders.get(clientOrderId) || null; }
    getLatestOrder() {
        const active = this.getActiveOrders();
        if (active.length === 0) return null;
        active.sort((a, b) => b.createdAt - a.createdAt);
        return active[0];
    }
    hasActiveOrders() { return this.getActiveOrders().length > 0; }
    getActiveCount() { return this.getActiveOrders().length; }
    getHistory(limit = 50) { return this.history.slice(-limit); }

    startReconcile(brokerAdapter) {
        if (this._reconcileTimer) clearInterval(this._reconcileTimer);
        this._reconcileTimer = setInterval(async () => { await this.reconcile(brokerAdapter); }, this.reconcileInterval);
    }
    stopReconcile() { if (this._reconcileTimer) { clearInterval(this._reconcileTimer); this._reconcileTimer = null; } }

    async reconcile(brokerAdapter) {
        if (this._isReconciling) return;
        this._isReconciling = true;
        try {
            this.cleanStalePending();
            const brokerOrders = await brokerAdapter.syncOrdersByList({ strategyId: this.strategyId });
            const brokerMap = new Map();
            for (const order of brokerOrders) {
                const activeStatuses = ['0', '1', '3', '5'];
                if (activeStatuses.includes(order.orderStatus) && order.orderStatus !== '9') {
                    brokerMap.set(order.clientOrderId, order);
                }
            }
            this.orders.clear();
            for (const [id, order] of brokerMap) { this.orders.set(id, order); }
        } catch (e) { logger.err(`[${this.strategyId}] Reconcile failed: ${e.message}`); }
        finally { this._isReconciling = false; }
    }

    startCleanup() {
        if (this._cleanupTimer) clearInterval(this._cleanupTimer);
        this._cleanupTimer = setInterval(() => { this.cleanStalePending(); }, 10000);
    }
    stopCleanup() { if (this._cleanupTimer) { clearInterval(this._cleanupTimer); this._cleanupTimer = null; } }

    cleanStalePending(maxAge = null) {
        const age = maxAge || this.pendingTimeout;
        const now = Date.now();
        const cleaned = [];
        for (const [id, pending] of this.pendingConfirmations) {
            if (now - pending.timestamp > age) cleaned.push(id);
        }
        for (const id of cleaned) {
            this.pendingConfirmations.delete(id);
            this._pendingSyncOrders.delete(id);
        }
        return cleaned;
    }

    addToHistory(order) {
        this.history.push({ ...order, archivedAt: new Date() });
        if (this.history.length > this.maxHistorySize) this.history.shift();
    }

    reset() {
        this.orders.clear();
        this.pendingConfirmations.clear();
        this._pendingSyncOrders.clear();
        this._pendingWsConfirmations.clear();
        this.stopReconcile();
        this.stopCleanup();
        this._initialized = false;
        this._isWsSynced = true;
    }

    getStats() {
        return {
            strategyId: this.strategyId,
            activeCount: this.getActiveCount(),
            validActiveCount: this.getValidActiveOrders().length,
            pendingCount: this.pendingConfirmations.size,
            historyCount: this.history.length,
            initialized: this._initialized,
            isWsSynced: this._isWsSynced,
            activeOrders: this.getActiveOrders().map(o => ({
                clientOrderId: o.clientOrderId,
                status: o.status,
                price: o.price,
                quantity: o.quantity,
                filledQuantity: o.filledQuantity || 0,
                attempts: o.attempts || 0,
                brokerOrderId: o.brokerOrderId || null,
            })),
        };
    }
}

module.exports = OrderStack;
EOF

# ============================================================
# 14. SRC/CORE/ORDER/ORDER-MANAGER.JS
# ============================================================
cat > src/core/order/order-manager.js << 'EOF'
const EventEmitter = require('events');
const OrderStack = require('./order-stack');
const logger = require('../../utils/logger');
const { ExecutionRequest } = require('../interfaces');
const { v4: uuidv4 } = require('uuid');

class OrderManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.stacks = new Map();
        this.globalHistory = [];
        this.maxHistorySize = options.maxHistorySize || 2000;
        this.defaultLimits = { maxActiveOrders: options.maxActiveOrders || 1, maxOrderValue: options.maxOrderValue || Infinity };
        this.strategyLimits = new Map();
        this.idempotencyCache = new Map();
        this.idempotencyTTL = options.idempotencyTTL || 60000;
        this.brokerAdapter = null;
        this.riskManager = null;
        this.executionQueue = null;
        this._cancelMap = new Map();
    }

    setBrokerAdapter(adapter) { this.brokerAdapter = adapter; }
    setRiskManager(riskManager) { this.riskManager = riskManager; }
    setExecutionQueue(queue) { this.executionQueue = queue; }

    getStack(strategyId) {
        if (!this.stacks.has(strategyId)) {
            const stack = new OrderStack(strategyId);
            this.stacks.set(strategyId, stack);
            stack.on('order_confirmed', (order) => this.emit('order_confirmed', { strategyId, order }));
            stack.on('order_filled', (order) => this.emit('order_filled', { strategyId, order }));
            stack.on('order_closed', (order) => this.emit('order_closed', { strategyId, order }));
            stack.on('order_updated', (order) => this.emit('order_updated', { strategyId, order }));
            stack.on('order_error', (data) => this.emit('order_error', { strategyId, data }));
            stack.on('emergency_stop', (data) => this.emit('emergency_stop', data));
        }
        return this.stacks.get(strategyId);
    }

    async initializeAll(strategies) {
        if (!this.brokerAdapter) throw new Error('BrokerAdapter not set');
        const results = [];
        for (const strategy of strategies) {
            try {
                const stack = this.getStack(strategy.id);
                await stack.initialize(this.brokerAdapter);
                results.push({ strategyId: strategy.id, success: true });
            } catch (e) {
                logger.err(`[${strategy.id}] Failed to initialize: ${e.message}`);
                results.push({ strategyId: strategy.id, success: false, error: e.message });
            }
        }
        return results;
    }

    processIntent(intent) {
        const { strategyId, action } = intent;
        if (this.idempotencyCache.has(intent.intentId)) {
            logger.warn(`[${strategyId}] Duplicate intent: ${intent.intentId}`);
            return { action: 'SKIP', reason: 'Duplicate intent', intentId: intent.intentId };
        }
        this.idempotencyCache.set(intent.intentId, true);
        setTimeout(() => this.idempotencyCache.delete(intent.intentId), this.idempotencyTTL);

        const stack = this.getStack(strategyId);
        switch (action) {
            case 'CANCEL': return this.handleCancel(intent, stack);
            case 'CREATE': return this.handleCreate(intent, stack);
            case 'MODIFY': return this.handleModify(intent, stack);
            default: return { action: 'REJECT', reason: `Unknown action: ${action}`, intentId: intent.intentId };
        }
    }

    handleCreate(intent, stack) {
        const strategyId = intent.strategyId;
        const limits = this.strategyLimits.get(strategyId) || this.defaultLimits;
        const activeOrders = stack.getValidActiveOrders();
        if (activeOrders.length >= limits.maxActiveOrders) {
            return { action: 'REJECT', reason: `Max active orders exceeded (${limits.maxActiveOrders})`, intentId: intent.intentId };
        }

        const request = new ExecutionRequest({
            intentId: intent.intentId,
            strategyId: intent.strategyId,
            action: 'CREATE',
            symbol: intent.symbol,
            classCode: intent.classCode || 'TQBR',
            side: intent.side,
            price: intent.price,
            quantity: intent.quantity,
            orderType: intent.orderType,
            metadata: intent.metadata,
        });

        if (this.riskManager) {
            const riskCheck = this.riskManager.validate(request);
            if (!riskCheck.approved) {
                return { action: 'REJECT', reason: riskCheck.reason, intentId: intent.intentId };
            }
            request.riskApproved = true;
        }

        stack.addPending({
            clientOrderId: request.clientOrderId,
            price: request.price,
            quantity: request.quantity,
            status: 'PENDING',
            createdAt: new Date(),
            strategyId: request.strategyId,
            symbol: request.symbol,
        });

        if (this.executionQueue) this.executionQueue.enqueue(request);
        return { action: 'CREATE', requestId: request.requestId, clientOrderId: request.clientOrderId, intentId: intent.intentId };
    }

    handleModify(intent, stack) {
        const strategyId = intent.strategyId;
        let existingOrder = null;

        if (intent.orderId) {
            existingOrder = stack.getOrderForModify(intent.orderId);
            if (!existingOrder) {
                logger.warn(`[${strategyId}] Order ${intent.orderId} cannot be modified, creating new`);
                return this.handleCreate(intent, stack);
            }
        } else {
            const activeOrders = stack.getValidActiveOrders();
            if (activeOrders.length === 0) {
                return this.handleCreate(intent, stack);
            }
            existingOrder = activeOrders[activeOrders.length - 1];
            if (!stack.canModifyOrder(existingOrder.clientOrderId)) {
                return this.handleCreate(intent, stack);
            }
        }

        if (existingOrder.price === intent.price) {
            return { action: 'SKIP', reason: 'Price unchanged', intentId: intent.intentId };
        }

        const brokerOrderId = existingOrder.brokerOrderId || existingOrder.orderId;
        if (!brokerOrderId || brokerOrderId === existingOrder.clientOrderId) {
            logger.warn(`[${strategyId}] Order ${existingOrder.clientOrderId} has no brokerOrderId`);
            return this.handleCreate(intent, stack);
        }

        const newClientOrderId = uuidv4();
        const request = new ExecutionRequest({
            intentId: intent.intentId,
            strategyId: intent.strategyId,
            action: 'MODIFY',
            symbol: intent.symbol,
            classCode: intent.classCode || 'TQBR',
            side: intent.side,
            price: intent.price,
            quantity: intent.quantity,
            orderType: intent.orderType,
            orderId: brokerOrderId,
            clientOrderId: newClientOrderId,
            metadata: { ...intent.metadata, oldClientOrderId: existingOrder.clientOrderId, brokerOrderId },
        });

        if (this.riskManager) {
            const riskCheck = this.riskManager.validate(request);
            if (!riskCheck.approved) {
                return { action: 'REJECT', reason: riskCheck.reason, intentId: intent.intentId };
            }
            request.riskApproved = true;
        }

        stack.addPending({
            clientOrderId: request.clientOrderId,
            price: request.price,
            quantity: request.quantity,
            status: 'PENDING_MODIFY',
            createdAt: new Date(),
            strategyId: request.strategyId,
            symbol: request.symbol,
            replaces: existingOrder.clientOrderId,
            brokerOrderId,
        });

        if (this.executionQueue) this.executionQueue.enqueue(request);
        return { action: 'MODIFY', requestId: request.requestId, clientOrderId: request.clientOrderId, replacesOrderId: existingOrder.clientOrderId, brokerOrderId, intentId: intent.intentId };
    }

    handleCancel(intent, stack) {
        const strategyId = intent.strategyId;
        if (intent.orderId) {
            const order = stack.getOrder(intent.orderId);
            if (!order) return { action: 'REJECT', reason: `Order ${intent.orderId} not found`, intentId: intent.intentId };
            return this.cancelOrder(intent.orderId, stack);
        }
        if (!stack.hasActiveOrders()) {
            return { action: 'SKIP', reason: 'No active orders to cancel', intentId: intent.intentId };
        }
        const results = [];
        for (const order of stack.getActiveOrders()) {
            results.push(this.cancelOrder(order.clientOrderId, stack));
        }
        return { action: 'CANCEL_ALL', results, intentId: intent.intentId };
    }

    cancelOrder(clientOrderId, stack) {
        const order = stack.getOrder(clientOrderId);
        if (!order) return { success: false, reason: 'Order not found', clientOrderId };

        const brokerOrderId = order.brokerOrderId || order.orderId;
        const cancelClientId = uuidv4();

        stack.addPending({
            clientOrderId: cancelClientId,
            price: order.price,
            quantity: order.quantity,
            status: 'PENDING_CANCEL',
            createdAt: new Date(),
            strategyId: stack.strategyId,
            symbol: order.symbol,
            originalOrderId: clientOrderId,
            originalBrokerOrderId: brokerOrderId,
        });

        const request = new ExecutionRequest({
            intentId: `cancel_${clientOrderId}_${Date.now()}`,
            strategyId: stack.strategyId,
            action: 'CANCEL',
            symbol: order.symbol || 'SBER',
            classCode: order.classCode || 'TQBR',
            side: 'BUY',
            price: order.price,
            quantity: order.quantity,
            orderId: brokerOrderId || clientOrderId,
            clientOrderId: cancelClientId,
            metadata: { originalOrderId: clientOrderId, originalBrokerOrderId: brokerOrderId },
        });

        if (this.executionQueue) this.executionQueue.enqueue(request);
        return { success: true, clientOrderId, requestId: request.requestId, cancelClientId };
    }

    syncWithWs(event) {
        const { clientOrderId } = event;
        if (!clientOrderId) { logger.warn(`[OrderManager] WS event without clientOrderId`); return; }
        for (const [id, stack] of this.stacks) {
            if (stack.getOrder(clientOrderId) || stack.isPending(clientOrderId)) {
                event.strategyId = id;
                stack.syncWithWs(event);
                return;
            }
        }
        logger.warn(`[OrderManager] Unknown order from WS: ${clientOrderId}`);
    }

    getActiveOrders(strategyId = null) {
        if (strategyId) return this.getStack(strategyId).getActiveOrders();
        const all = [];
        for (const [id, stack] of this.stacks) {
            all.push(...stack.getActiveOrders().map(o => ({ ...o, strategyId: id })));
        }
        return all;
    }

    getValidActiveOrders(strategyId = null) {
        if (strategyId) return this.getStack(strategyId).getValidActiveOrders();
        const all = [];
        for (const [id, stack] of this.stacks) {
            all.push(...stack.getValidActiveOrders().map(o => ({ ...o, strategyId: id })));
        }
        return all;
    }

    getOrder(strategyId, clientOrderId) {
        return this.getStack(strategyId).getOrder(clientOrderId);
    }

    getHistory(strategyId = null, limit = 50) {
        if (strategyId) return this.getStack(strategyId).getHistory(limit);
        const all = [];
        for (const [id, stack] of this.stacks) {
            all.push(...stack.getHistory(limit).map(o => ({ ...o, strategyId: id })));
        }
        all.sort((a, b) => b.archivedAt - a.archivedAt);
        return all.slice(0, limit);
    }

    getStats() {
        const stacks = {};
        for (const [id, stack] of this.stacks) stacks[id] = stack.getStats();
        return {
            stacks,
            totalActive: Array.from(this.stacks.values()).reduce((acc, s) => acc + s.getActiveCount(), 0),
            totalPending: Array.from(this.stacks.values()).reduce((acc, s) => acc + s.pendingConfirmations.size, 0),
            idempotencyCacheSize: this.idempotencyCache.size
        };
    }

    reset(strategyId = null) {
        if (strategyId) { const stack = this.stacks.get(strategyId); if (stack) stack.reset(); return; }
        for (const [id, stack] of this.stacks) stack.reset();
        this.stacks.clear();
        this.idempotencyCache.clear();
        this._cancelMap.clear();
    }

    shutdown() { for (const [id, stack] of this.stacks) stack.stopReconcile(); }
}

module.exports = OrderManager;
EOF

# ============================================================
# 15. SRC/CORE/ORDER/INDEX.JS
# ============================================================
cat > src/core/order/index.js << 'EOF'
const OrderStack = require('./order-stack');
const OrderManager = require('./order-manager');
module.exports = { OrderStack, OrderManager };
EOF

# ============================================================
# 16. SRC/CORE/EXECUTION/EXECUTION-QUEUE.JS
# ============================================================
cat > src/core/execution/execution-queue.js << 'EOF'
const EventEmitter = require('events');
const logger = require('../../utils/logger');

class ExecutionQueue extends EventEmitter {
    constructor(options = {}) {
        super();
        this.queues = { CRITICAL: [], HIGH: [], NORMAL: [] };
        this.processing = false;
        this.maxQueueSize = options.maxQueueSize || 1000;
        this.stats = { enqueued: 0, processed: 0, rejected: 0, maxWaitTime: 0, avgWaitTime: 0, totalWaitTime: 0 };
        this._processingTimer = null;
    }

    getPriority(action) {
        switch (action) { case 'CANCEL': return 'CRITICAL'; case 'MODIFY': return 'HIGH'; default: return 'NORMAL'; }
    }

    enqueue(request) {
        const priority = this.getPriority(request.action);
        const queue = this.queues[priority];
        const totalSize = this.getTotalSize();
        if (totalSize >= this.maxQueueSize) {
            logger.warn(`[Queue] Queue full, rejecting request`);
            this.stats.rejected++;
            this.emit('rejected', request);
            return false;
        }
        request.enqueuedAt = Date.now();
        queue.push(request);
        this.stats.enqueued++;
        logger.info(`[Queue] Enqueued ${request.action} (${priority}): ${request.clientOrderId}`);
        this.emit('enqueued', request);
        if (!this.processing) this.processNext();
        return true;
    }

    getTotalSize() { return this.queues.CRITICAL.length + this.queues.HIGH.length + this.queues.NORMAL.length; }

    dequeue() {
        if (this.queues.CRITICAL.length > 0) return this.queues.CRITICAL.shift();
        if (this.queues.HIGH.length > 0) return this.queues.HIGH.shift();
        if (this.queues.NORMAL.length > 0) return this.queues.NORMAL.shift();
        return null;
    }

    async processNext() {
        if (this.processing) return;
        const request = this.dequeue();
        if (!request) {
            if (this._processingTimer) { clearTimeout(this._processingTimer); this._processingTimer = null; }
            return;
        }
        this.processing = true;
        try {
            const waitTime = Date.now() - (request.enqueuedAt || Date.now());
            this.stats.totalWaitTime += waitTime;
            this.stats.maxWaitTime = Math.max(this.stats.maxWaitTime, waitTime);
            this.stats.processed++;
            this.emit('processing', request);
            const result = await this.executeRequest(request);
            this.emit('completed', { request, result });
        } catch (e) {
            logger.err(`[Queue] Execution error: ${e.message}`);
            this.emit('error', { request, error: e });
        } finally {
            this.processing = false;
            if (this.getTotalSize() > 0) {
                this._processingTimer = setTimeout(() => this.processNext(), 10);
            } else {
                this._processingTimer = null;
                this.emit('empty');
            }
        }
    }

    async executeRequest(request) { throw new Error('executeRequest must be implemented by Execution Engine'); }
    clear() { this.queues = { CRITICAL: [], HIGH: [], NORMAL: [] }; this.processing = false; }

    getStats() {
        return {
            ...this.stats,
            avgWaitTime: this.stats.processed > 0 ? (this.stats.totalWaitTime / this.stats.processed).toFixed(0) + 'ms' : '0ms',
            queueSizes: { CRITICAL: this.queues.CRITICAL.length, HIGH: this.queues.HIGH.length, NORMAL: this.queues.NORMAL.length, TOTAL: this.getTotalSize() },
            processing: this.processing
        };
    }
}

module.exports = ExecutionQueue;
EOF

# ============================================================
# 17. SRC/CORE/EXECUTION/EXECUTION-ENGINE.JS
# ============================================================
cat > src/core/execution/execution-engine.js << 'EOF'
const EventEmitter = require('events');
const logger = require('../../utils/logger');
const { ExecutionResult } = require('../interfaces');

class ExecutionEngine extends EventEmitter {
    constructor(options = {}) {
        super();
        this.brokerAdapter = null;
        this.orderManager = null;
        this.executionQueue = null;
        this.timeout = options.timeout || 5000;
        this.maxRetries = options.maxRetries || 3;
        this.retryDelay = options.retryDelay || 1000;
        this.confirmationTimeout = options.confirmationTimeout || 3000;
        this.stats = { total: 0, successful: 0, failed: 0, retries: 0, timeouts: 0, wsConfirmed: 0, restConfirmed: 0 };
        this._pendingRequests = new Map();
        this._isShuttingDown = false;
    }

    setBrokerAdapter(adapter) { this.brokerAdapter = adapter; }
    setOrderManager(manager) { this.orderManager = manager; }
    setExecutionQueue(queue) { this.executionQueue = queue; queue.executeRequest = this.executeRequest.bind(this); }

    start() {
        if (!this.brokerAdapter) throw new Error('BrokerAdapter not set');
        if (!this.executionQueue) throw new Error('ExecutionQueue not set');
        logger.info('[Engine] Starting execution engine...');
        this.executionQueue.processNext();
    }

    async executeRequest(request) {
        if (this._isShuttingDown) throw new Error('Engine is shutting down');
        const startTime = Date.now();
        this.stats.total++;
        logger.info(`[Engine] Executing ${request.action}: ${request.clientOrderId} @ ${request.price || 'market'}`);
        try {
            let result, attempts = 0, lastError = null;
            while (attempts < this.maxRetries) {
                try { result = await this.executeWithTimeout(request); break; }
                catch (e) { attempts++; lastError = e; if (attempts < this.maxRetries) { await this.sleep(this.retryDelay * Math.pow(2, attempts - 1) / 1000); this.stats.retries++; } }
            }
            if (!result || !result.success) throw new Error(`Broker request failed: ${lastError?.message || 'Unknown error'}`);
            const confirmed = await this.waitForConfirmation(request, result);
            const duration = Date.now() - startTime;
            const executionResult = new ExecutionResult({
                requestId: request.requestId, clientOrderId: request.clientOrderId,
                brokerOrderId: result.brokerOrderId || null, success: confirmed,
                status: confirmed ? 'CONFIRMED' : 'TIMEOUT',
                source: confirmed ? (result.source || 'ws') : 'timeout',
                data: confirmed ? result : null, attempts: attempts + 1
            });
            if (confirmed) { this.stats.successful++; logger.ok(`[Engine] ${request.action} confirmed: ${request.clientOrderId} (${duration}ms)`); }
            else { this.stats.failed++; this.stats.timeouts++; logger.err(`[Engine] ${request.action} timeout: ${request.clientOrderId}`); }
            this.emit('execution_complete', executionResult);
            return executionResult;
        } catch (e) {
            this.stats.failed++;
            logger.err(`[Engine] ${request.action} failed: ${request.clientOrderId} - ${e.message}`);
            const executionResult = new ExecutionResult({
                requestId: request.requestId, clientOrderId: request.clientOrderId,
                success: false, status: 'ERROR', error: e.message, attempts: 1
            });
            this.emit('execution_error', { request, error: e });
            throw e;
        }
    }

    async executeWithTimeout(request) {
        return Promise.race([
            this.executeBrokerRequest(request),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Broker request timeout (${this.timeout}ms)`)), this.timeout))
        ]);
    }

    async executeBrokerRequest(request) {
        switch (request.action) {
            case 'CREATE': return this.brokerAdapter.createOrder(request);
            case 'MODIFY': return this.brokerAdapter.modifyOrder(request);
            case 'CANCEL': return this.brokerAdapter.cancelOrder(request);
            default: throw new Error(`Unknown action: ${request.action}`);
        }
    }

    async waitForConfirmation(request, brokerResult) {
        const { clientOrderId, strategyId, action } = request;
        if (!brokerResult || !brokerResult.success) return false;
        const wsResult = await this.waitForWsConfirmation(strategyId, clientOrderId, action);
        if (wsResult.confirmed) { this.stats.wsConfirmed++; return true; }
        const restConfirmed = await this.checkRestStatus(brokerResult.orderId || clientOrderId, action);
        if (restConfirmed) { this.stats.restConfirmed++; return true; }
        return false;
    }

    waitForWsConfirmation(strategyId, clientOrderId, expectedAction) {
        const timeout = this.confirmationTimeout || 3000;
        return new Promise((resolve) => {
            if (!this.orderManager) { resolve({ confirmed: false, status: null, reason: 'no order manager' }); return; }
            const stack = this.orderManager.getStack(strategyId);
            if (!stack) { resolve({ confirmed: false, status: null, reason: 'no stack' }); return; }
            const order = stack.getOrder(clientOrderId);
            if (order && order.wsConfirmed) { resolve({ confirmed: true, status: order.status, reason: 'already confirmed' }); return; }
            if (!stack.isPending(clientOrderId)) { resolve({ confirmed: false, status: null, reason: 'not pending' }); return; }
            let resolved = false;
            const timeoutId = setTimeout(() => { if (!resolved) { resolved = true; resolve({ confirmed: false, status: null, reason: 'timeout' }); } }, timeout);
            const handler = (data) => {
                const orderData = data.order || data;
                if (orderData.clientOrderId === clientOrderId) {
                    if (!resolved) { resolved = true; clearTimeout(timeoutId); resolve({ confirmed: true, status: orderData.status || data.status, reason: 'ws event' }); }
                }
            };
            stack.once('order_confirmed', handler);
            stack.once('order_updated', handler);
            stack.once('order_closed', handler);
        });
    }

    async checkRestStatus(orderId, action) {
        if (!this.brokerAdapter) return false;
        try {
            const status = await this.brokerAdapter.getOrderStatus(orderId);
            return status !== null;
        } catch (e) { return false; }
    }

    getStats() {
        return { ...this.stats, successRate: this.stats.total > 0 ? ((this.stats.successful / this.stats.total) * 100).toFixed(1) + '%' : '0%' };
    }

    async shutdown() {
        this._isShuttingDown = true;
        if (this.executionQueue) this.executionQueue.clear();
        logger.info('[Engine] Shutdown complete');
    }
    sleep(seconds) { return new Promise(resolve => setTimeout(resolve, seconds * 1000)); }
}

module.exports = ExecutionEngine;
EOF

# ============================================================
# 18. SRC/CORE/EXECUTION/INDEX.JS
# ============================================================
cat > src/core/execution/index.js << 'EOF'
const ExecutionQueue = require('./execution-queue');
const ExecutionEngine = require('./execution-engine');
module.exports = { ExecutionQueue, ExecutionEngine };
EOF

# ============================================================
# 19. SRC/CORE/CHECKER/CONDITION-EVALUATOR.JS
# ============================================================
cat > src/core/checker/condition-evaluator.js << 'EOF'
const EventEmitter = require('events');
const logger = require('../../utils/logger');

class ConditionEvaluator extends EventEmitter {
    constructor(marketDataProvider) {
        super();
        this.marketData = marketDataProvider;
        this.strategies = new Map();
        this.orderManager = null;
        this.isRunning = false;
        this.checkInterval = null;
        this.maxCallsPerSecond = 10;
        this._callCounts = new Map();
    }

    setOrderManager(manager) { this.orderManager = manager; }

    registerStrategy(strategy, conditionFn) {
        this.strategies.set(strategy.id, { strategy, condition: conditionFn, lastCall: 0 });
        logger.ok(`[Evaluator] Strategy registered: ${strategy.id}`);
        this.emit('strategy_registered', strategy.id);
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.marketData.on('orderbook', (book) => this.checkAllStrategies(book));
        this.checkInterval = setInterval(() => {
            if (this.marketData.hasValidData && this.marketData.hasValidData()) {
                const book = this.marketData.getOrderBook();
                if (book) this.checkAllStrategies(book);
            }
        }, 1000);
        logger.ok('[Evaluator] Started monitoring');
        this.emit('started');
    }

    stop() {
        this.isRunning = false;
        if (this.checkInterval) { clearInterval(this.checkInterval); this.checkInterval = null; }
        this.marketData.removeAllListeners('orderbook');
        logger.info('[Evaluator] Stopped');
        this.emit('stopped');
    }

    checkAllStrategies(book) {
        if (!this.isRunning || !book) return;
        for (const [strategyId, data] of this.strategies) {
            this.checkStrategy(strategyId, data, book);
        }
    }

    checkStrategy(strategyId, data, book) {
        try {
            if (!this.checkRateLimit(strategyId)) return;
            if (!data.condition(book)) return;
            const strategy = data.strategy;
            const midPrice = (book.bids[0].price + book.asks[0].price) / 2;
            if (!midPrice) return;
            const bidPrice = strategy.calculateBidPrice(midPrice);
            if (!bidPrice || bidPrice <= 0) return;
            const stack = this.orderManager?.getStack(strategyId);
            if (!stack) return;
            const activeOrders = stack.getValidActiveOrders();
            const pendingOrders = stack.getPendingOrders();
            const hasPendingModify = pendingOrders.some(p => p.status === 'PENDING_MODIFY' || p.status === 'PENDING' || p.status === 'PENDING_CANCEL');
            if (hasPendingModify && activeOrders.length > 0) { return; }
            const params = {
                midPrice, bidPrice, spread: book.asks[0].price - book.bids[0].price,
                marketData: book, activeOrders, pendingOrders, hasPendingModify,
                timestamp: new Date(), cycle: (data.lastCall || 0) + 1
            };
            const result = strategy.onData(params);
            if (!result) return;
            const intents = Array.isArray(result) ? result : [result];
            for (const intent of intents) { if (intent) this.emit('intent', intent); }
            data.lastCall = Date.now();
        } catch (e) {
            logger.err(`[Evaluator] Strategy ${strategyId} error: ${e.message}`);
            this.emit('error', { strategyId, error: e });
        }
    }

    checkRateLimit(strategyId) {
        const now = Date.now();
        let counter = this._callCounts.get(strategyId);
        if (!counter) { counter = { count: 0, resetTime: now + 1000 }; this._callCounts.set(strategyId, counter); }
        if (now > counter.resetTime) { counter.count = 0; counter.resetTime = now + 1000; }
        if (counter.count >= this.maxCallsPerSecond) { return false; }
        counter.count++;
        return true;
    }

    getStats() {
        return {
            isRunning: this.isRunning,
            strategiesCount: this.strategies.size,
            callCounts: Array.from(this._callCounts.entries()).map(([id, counter]) => ({ strategyId: id, count: counter.count })),
        };
    }
}

module.exports = ConditionEvaluator;
EOF

# ============================================================
# 20. SRC/CORE/CHECKER/INDEX.JS
# ============================================================
cat > src/core/checker/index.js << 'EOF'
const ConditionEvaluator = require('./condition-evaluator');
module.exports = { ConditionEvaluator };
EOF

# ============================================================
# 21. SRC/CORE/RISK/RISK-MANAGER.JS
# ============================================================
cat > src/core/risk/risk-manager.js << 'EOF'
const EventEmitter = require('events');
const logger = require('../../utils/logger');

class RiskManager extends EventEmitter {
    constructor(config = {}) {
        super();
        this.config = {
            dailyLossLimit: config.dailyLossLimit || -10000,
            maxPosition: config.maxPosition || 1000,
            maxOrderRate: config.maxOrderRate || 10,
            maxOrderValue: config.maxOrderValue || 100000,
            maxConsecutiveErrors: config.maxConsecutiveErrors || 5,
            maxDailyOrders: config.maxDailyOrders || 1000,
            minPrice: config.minPrice || 1,
            maxPrice: config.maxPrice || 1000000,
            minQuantity: config.minQuantity || 1,
            maxQuantity: config.maxQuantity || 10000,
            ...config
        };
        this.state = {
            dailyPnl: 0, dailyOrders: 0, dailyLoss: 0, totalPosition: 0,
            orderCount: 0, orderWindow: [], errors: 0, lastErrorAt: null,
            isCircuitBreakerOpen: false, circuitBreakerTrippedAt: null,
            circuitBreakerReason: null, startTime: new Date()
        };
        this._resetTimer = null;
        this._lastResetDate = new Date().toDateString();
    }

    start() {
        this._resetTimer = setInterval(() => this.checkDailyReset(), 3600000);
        logger.info('[Risk] Risk Manager started');
    }

    stop() { if (this._resetTimer) { clearInterval(this._resetTimer); this._resetTimer = null; } }

    validate(request) {
        const result = { approved: false, reason: null, metadata: {} };
        try {
            if (this.state.isCircuitBreakerOpen) return this.reject(result, 'Circuit breaker is open');
            if (this.state.dailyLoss < this.config.dailyLossLimit) {
                this.tripCircuitBreaker(`Daily loss limit exceeded: ${this.state.dailyLoss}`);
                return this.reject(result, 'Daily loss limit exceeded');
            }
            if (this.state.dailyOrders >= this.config.maxDailyOrders) {
                return this.reject(result, `Daily order limit exceeded`);
            }
            if (request.price <= 0) return this.reject(result, 'Invalid price');
            if (request.price < this.config.minPrice || request.price > this.config.maxPrice) {
                return this.reject(result, 'Price out of range');
            }
            if (request.quantity <= 0 || request.quantity < this.config.minQuantity || request.quantity > this.config.maxQuantity) {
                return this.reject(result, 'Invalid quantity');
            }
            if (request.price * request.quantity > this.config.maxOrderValue) {
                return this.reject(result, 'Order value exceeds limit');
            }
            result.approved = true;
            result.metadata = {
                dailyOrdersAfter: this.state.dailyOrders + 1,
                orderValue: request.price * request.quantity
            };
            this.state.dailyOrders++;
            this.state.orderWindow.push(Date.now());
            this.emit('request_approved', { request, result });
            return result;
        } catch (e) {
            return this.reject(result, `Validation error: ${e.message}`);
        }
    }

    reject(result, reason) { result.approved = false; result.reason = reason; return result; }

    tripCircuitBreaker(reason) {
        if (this.state.isCircuitBreakerOpen) return;
        this.state.isCircuitBreakerOpen = true;
        this.state.circuitBreakerTrippedAt = new Date();
        this.state.circuitBreakerReason = reason;
        logger.err(`🚨 Circuit breaker tripped: ${reason}`);
        this.emit('circuit_breaker_tripped', { reason, state: this.state });
    }

    resetCircuitBreaker() {
        this.state.isCircuitBreakerOpen = false;
        this.state.circuitBreakerTrippedAt = null;
        this.state.circuitBreakerReason = null;
        this.state.errors = 0;
        logger.ok('[Risk] Circuit breaker reset');
        this.emit('circuit_breaker_reset');
    }

    checkDailyReset() {
        const today = new Date().toDateString();
        if (today !== this._lastResetDate) {
            this._lastResetDate = today;
            this.state.dailyPnl = 0;
            this.state.dailyOrders = 0;
            this.state.dailyLoss = 0;
            this.state.errors = 0;
            this.state.orderWindow = [];
            logger.info('[Risk] Daily limits reset');
            this.emit('daily_reset');
        }
    }

    getState() { return { ...this.state, uptime: (Date.now() - this.state.startTime.getTime()) / 1000 }; }
    getStats() { return { state: this.getState(), config: this.config }; }
}

module.exports = RiskManager;
EOF

# ============================================================
# 22. SRC/CORE/RISK/INDEX.JS
# ============================================================
cat > src/core/risk/index.js << 'EOF'
const RiskManager = require('./risk-manager');
module.exports = { RiskManager };
EOF

# ============================================================
# 23. SRC/CORE/INDEX.JS
# ============================================================
cat > src/core/index.js << 'EOF'
const { TradeIntent, ExecutionRequest, ExecutionResult, OrderStatusEvent } = require('./interfaces');
const { OrderStack, OrderManager } = require('./order');
const { ExecutionQueue, ExecutionEngine } = require('./execution');
const { ConditionEvaluator } = require('./checker');
const { RiskManager } = require('./risk');

module.exports = {
    TradeIntent, ExecutionRequest, ExecutionResult, OrderStatusEvent,
    OrderStack, OrderManager,
    ExecutionQueue, ExecutionEngine,
    ConditionEvaluator, RiskManager
};
EOF

# ============================================================
# 24. SRC/STRATEGIES/BASE-STRATEGY.JS
# ============================================================
cat > src/strategies/base-strategy.js << 'EOF'
const { TradeIntent } = require('../core/interfaces');

class BaseStrategy {
    constructor(config) {
        this.id = config.id || 'default';
        this.symbol = config.symbol || 'SBER';
        this.classCode = config.classCode || 'TQBR';
        this.config = config;
        this.createdAt = new Date();
        this.metrics = { calls: 0, intentsGenerated: 0, lastCall: null };
        this.orderManager = null;
        this.isActive = false;
    }

    setOrderManager(orderManager) { this.orderManager = orderManager; }

    onData(params) { throw new Error('onData() must be implemented'); }

    start() { this.isActive = true; }
    stop() { this.isActive = false; }

    calculateBidPrice(midPrice) { throw new Error('calculateBidPrice() must be implemented'); }

    getInfo() {
        return {
            id: this.id, symbol: this.symbol, classCode: this.classCode,
            type: this.constructor.name, config: this.config,
            metrics: this.metrics, createdAt: this.createdAt,
            state: { isActive: this.isActive }
        };
    }

    createIntent(action, price, quantity, metadata = {}) {
        this.metrics.intentsGenerated++;
        return new TradeIntent({
            strategyId: this.id,
            symbol: this.symbol,
            classCode: this.classCode,
            action: action,
            side: 'BUY',
            price: price,
            quantity: quantity,
            orderType: 'LIMIT',
            metadata: metadata,
        });
    }

    createModifyIntent(clientOrderId, newPrice, quantity, metadata = {}) {
        this.metrics.intentsGenerated++;
        return new TradeIntent({
            strategyId: this.id,
            symbol: this.symbol,
            classCode: this.classCode,
            action: 'MODIFY',
            side: 'BUY',
            price: newPrice,
            quantity: quantity,
            orderType: 'LIMIT',
            orderId: clientOrderId,
            metadata: { ...metadata, oldPrice: metadata.oldPrice || null },
        });
    }

    reset() { this.metrics.calls = 0; this.metrics.intentsGenerated = 0; this.metrics.lastCall = null; }
}

module.exports = BaseStrategy;
EOF

# ============================================================
# 25. SRC/STRATEGIES/CONSTANT-BID-STRATEGY.JS
# ============================================================
cat > src/strategies/constant-bid-strategy.js << 'EOF'
const BaseStrategy = require('./base-strategy');
const logger = require('../utils/logger');

class ConstantBidStrategy extends BaseStrategy {
    constructor(config) {
        super(config);
        this.offsetPercent = config.offsetPercent || 1;
        this.quantity = config.quantity || 1;
        this.side = config.side || 'BUY';
        this.minPrice = config.minPrice || 0;
        this.maxPrice = config.maxPrice || Infinity;
        this.modifyThreshold = config.modifyThreshold || 0.05;
        this.cycleCount = 0;
        this.lastMidPrice = null;
    }

    start() {
        this.isActive = true;
        this.cycleCount = 0;
        this.lastMidPrice = null;
        logger.ok(`[${this.id}] Strategy started`);
    }

    stop() {
        this.isActive = false;
        logger.info(`[${this.id}] Strategy stopped`);
    }

    onData(params) {
        if (!this.isActive) return null;
        this.metrics.calls++;
        const { midPrice, bidPrice, spread, activeOrders, pendingOrders, hasPendingModify, cycle } = params;
        this.lastMidPrice = midPrice;
        this.cycleCount = cycle || this.cycleCount + 1;

        if (hasPendingModify && activeOrders.length > 0) {
            logger.debug(`[${this.id}] Pending modify exists, waiting...`);
            return null;
        }

        const intents = [];
        if (activeOrders.length > 0) {
            for (const order of activeOrders) {
                if (String(order.status) === '9' || String(order.status) === 'REPLACING') {
                    logger.debug(`[${this.id}] Order ${order.clientOrderId} is REPLACING, skipping`);
                    continue;
                }
                const activeStatuses = ['CREATED', 'MODIFIED', 'PARTIALLY_FILLED', 'PENDING', 'ACTIVE', '0', '1', '3', '5'];
                if (!activeStatuses.includes(String(order.status))) {
                    logger.debug(`[${this.id}] Order ${order.clientOrderId} is not active (${order.status})`);
                    continue;
                }
                if (!order.brokerOrderId || order.brokerOrderId === order.clientOrderId) {
                    logger.debug(`[${this.id}] Order ${order.clientOrderId} has no brokerOrderId`);
                    continue;
                }
                if (this.shouldModify(order.price, bidPrice)) {
                    logger.info(`[${this.id}] Modifying order ${order.clientOrderId}: ${order.price} → ${bidPrice}`);
                    const intent = this.createModifyIntent(
                        order.clientOrderId, bidPrice,
                        order.quantity || this.quantity,
                        { midPrice, oldPrice: order.price, spread, cycle: this.cycleCount }
                    );
                    intents.push(intent);
                }
            }
            if (intents.length > 0) return intents;
            return null;
        }

        if (pendingOrders.length === 0) {
            logger.info(`[${this.id}] Creating new order at ${bidPrice} (mid: ${midPrice})`);
            const intent = this.createIntent('CREATE', bidPrice, this.quantity, {
                midPrice, offsetPercent: this.offsetPercent,
                spread, cycle: this.cycleCount
            });
            return [intent];
        }

        return null;
    }

    calculateBidPrice(midPrice) {
        if (!midPrice || midPrice <= 0) return 0;
        const price = midPrice * (1 - this.offsetPercent / 100);
        return Math.round(price * 100) / 100;
    }

    shouldModify(currentPrice, newPrice) {
        if (!currentPrice || !newPrice) return false;
        return Math.abs(currentPrice - newPrice) >= this.modifyThreshold;
    }

    getInfo() {
        return {
            ...super.getInfo(),
            state: {
                isActive: this.isActive,
                lastMidPrice: this.lastMidPrice,
                cycleCount: this.cycleCount,
            },
            params: {
                offsetPercent: this.offsetPercent,
                quantity: this.quantity,
                side: this.side,
                minPrice: this.minPrice,
                maxPrice: this.maxPrice,
                modifyThreshold: this.modifyThreshold,
            },
        };
    }
}

module.exports = ConstantBidStrategy;
EOF

# ============================================================
# 26. SRC/STRATEGIES/REGISTRY.JS
# ============================================================
cat > src/strategies/registry.js << 'EOF'
const logger = require('../utils/logger');

class StrategyRegistry {
    constructor() {
        this.strategies = new Map();
        this.evaluator = null;
    }

    setEvaluator(evaluator) {
        this.evaluator = evaluator;
        for (const [id, { strategy, condition }] of this.strategies) {
            evaluator.registerStrategy(strategy, condition);
        }
        logger.info(`[Registry] Connected to evaluator, ${this.strategies.size} strategies registered`);
    }

    register(strategy, conditionFn) {
        if (this.strategies.has(strategy.id)) {
            logger.warn(`[Registry] Strategy ${strategy.id} already registered, replacing`);
        }
        this.strategies.set(strategy.id, { strategy, condition: conditionFn });
        if (this.evaluator) {
            this.evaluator.registerStrategy(strategy, conditionFn);
        }
        logger.ok(`[Registry] Strategy registered: ${strategy.id} (${strategy.symbol})`);
        return this;
    }

    get(id) {
        return this.strategies.get(id)?.strategy || null;
    }

    getAll() {
        return Array.from(this.strategies.values()).map(({ strategy }) => strategy);
    }

    getInfo() {
        return Array.from(this.strategies.entries()).map(([id, { strategy }]) => ({
            id,
            info: strategy.getInfo ? strategy.getInfo() : {
                symbol: strategy.symbol,
                type: strategy.constructor.name
            }
        }));
    }

    remove(id) {
        if (!this.strategies.has(id)) return false;
        this.strategies.delete(id);
        logger.info(`[Registry] Strategy removed: ${id}`);
        return true;
    }

    resetAll() {
        for (const [, { strategy }] of this.strategies) {
            if (strategy.reset) strategy.reset();
        }
        logger.info('[Registry] All strategies reset');
    }

    size() {
        return this.strategies.size;
    }
}

module.exports = new StrategyRegistry();
EOF

# ============================================================
# 27. SRC/ADAPTERS/BCS-ADAPTER.JS
# ============================================================
cat > src/adapters/bcs-adapter.js << 'EOF'
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

class BcsAdapter {
    constructor(restApi) {
        this.restApi = restApi;
    }

    async createOrder(request) {
        const clientOrderId = request.clientOrderId || uuidv4();
        const params = {
            clientOrderId,
            price: request.price,
            orderQuantity: request.quantity,
            ticker: request.symbol || 'SBER',
            classCode: request.classCode || 'TQBR',
            side: request.side === 'BUY' ? '1' : '2',
            orderType: request.orderType === 'LIMIT' ? '2' : '1',
        };
        logger.info(`[BcsAdapter] Creating order: ${clientOrderId} @ ${request.price}`);
        try {
            const response = await this.restApi.createOrder(params);
            if (response.status === 'OK') {
                return { success: true, orderId: clientOrderId, brokerOrderId: null, status: 'PENDING', source: 'rest' };
            }
            throw new Error(`Create order failed: ${JSON.stringify(response)}`);
        } catch (e) {
            logger.err(`[BcsAdapter] Create order error: ${e.message}`);
            throw e;
        }
    }

    async modifyOrder(request) {
        if (!request.orderId) throw new Error('modifyOrder: orderId is required');
        const newClientOrderId = request.clientOrderId || uuidv4();
        const params = {
            orderIdType: '2',
            orderId: request.orderId,
            clientOrderId: newClientOrderId,
            price: request.price,
            orderQuantity: request.quantity,
            ticker: request.symbol || 'SBER',
            classCode: request.classCode || 'TQBR',
            orderType: request.orderType === 'LIMIT' ? '2' : '1',
        };
        logger.info(`[BcsAdapter] Modifying order: ${request.orderId} → ${newClientOrderId} @ ${request.price}`);
        try {
            const response = await this.restApi.modifyOrder(params);
            if (response.status === 'OK') {
                return { success: true, orderId: newClientOrderId, brokerOrderId: null, status: 'PENDING_MODIFY', source: 'rest' };
            }
            throw new Error(`Modify order failed: ${JSON.stringify(response)}`);
        } catch (e) {
            logger.err(`[BcsAdapter] Modify order error: ${e.message}`);
            throw e;
        }
    }

    async cancelOrder(request) {
        if (!request.orderId) throw new Error('cancelOrder: orderId is required');
        const newClientOrderId = request.clientOrderId || uuidv4();
        const params = {
            orderIdType: '2',
            orderId: request.orderId,
            clientOrderId: newClientOrderId,
        };
        logger.info(`[BcsAdapter] Cancelling order: ${request.orderId}`);
        try {
            const response = await this.restApi.cancelOrder(params);
            if (response.status === 'OK' || response.type === 'BAD_REQUEST') {
                return { success: true, orderId: request.orderId, status: 'CANCELLED', source: 'rest', clientOrderId: newClientOrderId };
            }
            throw new Error(`Cancel order failed: ${JSON.stringify(response)}`);
        } catch (e) {
            logger.err(`[BcsAdapter] Cancel order error: ${e.message}`);
            throw e;
        }
    }

    async getOrderStatusByUUID(uuid) {
        if (!uuid) return null;
        try {
            const response = await this.restApi.requestWithRetry('GET', `/trade-api-bff-operations/api/v1/orders?orderIdType=1&orderId=${uuid}`);
            if (response.statusCode === 200 && response.body) {
                return {
                    success: true,
                    clientOrderId: response.body.clientOrderId || uuid,
                    originalClientOrderId: response.body.originalClientOrderId || uuid,
                    orderStatus: response.body.data?.orderStatus || null,
                    brokerOrderId: response.body.data?.orderId || null,
                    ...response.body.data
                };
            }
            return null;
        } catch (e) {
            if (!e.message?.includes('404')) logger.warn(`[BcsAdapter] Status check error for ${uuid}: ${e.message}`);
            return null;
        }
    }

    async getOrderStatusByBrokerId(brokerOrderId) {
        if (!brokerOrderId) return null;
        try {
            const response = await this.restApi.requestWithRetry('GET', `/trade-api-bff-operations/api/v1/orders?orderIdType=2&orderId=${brokerOrderId}`);
            if (response.statusCode === 200 && response.body) {
                return {
                    success: true,
                    clientOrderId: response.body.clientOrderId || null,
                    originalClientOrderId: response.body.originalClientOrderId || null,
                    orderStatus: response.body.data?.orderStatus || null,
                    brokerOrderId: response.body.data?.orderId || brokerOrderId,
                    ...response.body.data
                };
            }
            return null;
        } catch (e) {
            if (!e.message?.includes('404')) logger.warn(`[BcsAdapter] Status check error for ${brokerOrderId}: ${e.message}`);
            return null;
        }
    }

    async getOrderStatus(orderId) {
        if (!orderId) return null;
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const result = uuidRegex.test(orderId) ?
            await this.getOrderStatusByUUID(orderId) :
            await this.getOrderStatusByBrokerId(orderId);
        return result?.orderStatus || null;
    }

    async getActiveOrdersList(options = {}) {
        try {
            const searchBody = {
                orderStatus: [3],
                tickers: options.ticker ? [options.ticker] : undefined,
                classCodes: options.classCode ? [options.classCode] : undefined,
                startDateTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
                endDateTime: new Date().toISOString(),
            };
            Object.keys(searchBody).forEach(key => {
                if (searchBody[key] === undefined) delete searchBody[key];
            });
            const response = await this.restApi.requestWithRetry('POST', '/trade-api-bff-order-details/api/v1/orders/search?page=0&size=100', searchBody);
            if (response?.body?.records) {
                logger.info(`[BcsAdapter] Found ${response.body.records.length} active orders`);
                return response.body.records;
            }
            return [];
        } catch (e) {
            logger.warn(`[BcsAdapter] getActiveOrdersList error: ${e.message}`);
            return [];
        }
    }

    async getActiveOrdersWithDetails(options = {}) {
        const records = await this.getActiveOrdersList(options);
        const result = [];
        const addedBrokerOrderIds = new Set();

        for (const record of records) {
            const brokerOrderId = record.orderId;
            if (addedBrokerOrderIds.has(brokerOrderId)) continue;

            const statusResult = await this.getOrderStatusByBrokerId(brokerOrderId);
            if (!statusResult?.success) continue;

            const orderStatus = statusResult.orderStatus;
            const originalClientOrderId = statusResult.originalClientOrderId || null;
            const currentClientOrderId = statusResult.clientOrderId || null;

            const activeStatuses = ['0', '1', '3', '5'];
            if (!activeStatuses.includes(orderStatus)) continue;
            if (orderStatus === '9') continue;

            const order = {
                clientOrderId: currentClientOrderId || brokerOrderId,
                orderId: brokerOrderId,
                brokerOrderId: brokerOrderId,
                price: record.price || statusResult.price || 0,
                quantity: record.orderQuantity || statusResult.orderQuantity || 0,
                filledQuantity: record.executedQuantity || statusResult.executedQuantity || 0,
                remainingQuantity: record.remainedQuantity || statusResult.remainedQuantity || 0,
                status: this.mapOrderStatus(orderStatus),
                orderStatus: orderStatus,
                side: record.side === 1 ? 'BUY' : 'SELL',
                orderType: this.mapOrderType(record.orderType || statusResult.orderType),
                symbol: record.ticker || statusResult.ticker || 'SBER',
                classCode: record.classCode || statusResult.classCode || 'TQBR',
                createdAt: new Date(record.orderDateTime || statusResult.transactionTime || Date.now()),
                updatedAt: new Date(record.updateDateTime || statusResult.transactionTime || Date.now()),
                replacedOrderId: orderStatus === '5' ? originalClientOrderId : null,
                originalClientOrderId: orderStatus === '5' ? originalClientOrderId : null,
                wsConfirmed: false,
                restConfirmed: true,
                synced: true,
            };
            result.push(order);
            addedBrokerOrderIds.add(brokerOrderId);
        }

        logger.info(`[BcsAdapter] Retrieved ${result.length} active orders`);
        return result;
    }

    async syncOrdersByList(options = {}) {
        return await this.getActiveOrdersWithDetails(options);
    }

    mapOrderStatus(status) {
        const map = {
            '1': 'CANCELLED', '2': 'FILLED', '3': 'ACTIVE',
            '0': 'PENDING', '4': 'CANCELLED', '5': 'REPLACED',
            '6': 'CANCELLING', '7': 'REJECTED', '8': 'ERROR',
            '9': 'REPLACING', '10': 'PENDING'
        };
        return map[String(status)] || 'UNKNOWN';
    }

    mapOrderType(type) {
        const map = {
            '1': 'MARKET', '2': 'LIMIT', '3': 'ICEBERG',
            '4': 'STOP_LIMIT', '5': 'TAKE_PROFIT', '6': 'STOP_LOSS',
            '7': 'TAKE_PROFIT_STOP_LOSS', '10': 'LIMIT_30_DAYS',
            '11': 'TAKE_PROFIT', '12': 'TRAILING_STOP'
        };
        return map[String(type)] || 'UNKNOWN';
    }
}

module.exports = BcsAdapter;
EOF

# ============================================================
# 28. SRC/DB/INDEX.JS
# ============================================================
cat > src/db/index.js << 'EOF'
const { Pool } = require('pg');
const config = require('../config');

class Database {
    constructor() {
        this.pool = null;
        this.isConnected = false;
    }

    async connect() {
        if (this.isConnected) return;
        this.pool = new Pool({
            host: config.db.host || 'localhost',
            port: config.db.port || 5432,
            database: config.db.database || 'trading_bot',
            user: config.db.user || 'trading_bot',
            password: config.db.password,
            max: config.db.poolSize || 20,
            idleTimeoutMillis: config.db.idleTimeout || 30000,
            connectionTimeoutMillis: config.db.connectionTimeout || 5000,
        });
        this.pool.on('error', (err) => console.error('[DB] Unexpected error:', err.message));
        try {
            await this.pool.query('SELECT 1');
            this.isConnected = true;
            console.log('✅ Database connected');
        } catch (err) {
            console.error('❌ Database connection failed:', err.message);
            throw err;
        }
    }

    async disconnect() {
        if (this.pool) {
            await this.pool.end();
            this.isConnected = false;
            console.log('🔌 Database disconnected');
        }
    }

    async query(sql, params) {
        if (!this.isConnected) throw new Error('Database not connected');
        return this.pool.query(sql, params);
    }

    async transaction(callback) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await callback(client);
            await client.query('COMMIT');
            return result;
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    get isConnected() { return this.isConnected; }
}

module.exports = new Database();
EOF

# ============================================================
# 29. SRC/DB/ORDER-DAO.JS
# ============================================================
cat > src/db/order-dao.js << 'EOF'
const db = require('./index');

class OrderDAO {
    async createOrder(orderData) {
        const query = `
            INSERT INTO orders (
                client_order_id, broker_order_id, strategy_id, instrument_id,
                side, order_type, price, quantity, filled_quantity, remaining_quantity,
                status, broker_status, role, metadata, raw_broker_response,
                broker_order_number, broker_client_code, broker_execution_id,
                broker_transaction_time, is_active, is_ws_confirmed, is_rest_confirmed
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                      $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
            ON CONFLICT (client_order_id) DO UPDATE SET
                broker_order_id = EXCLUDED.broker_order_id,
                status = EXCLUDED.status,
                broker_status = EXCLUDED.broker_status,
                updated_at = CURRENT_TIMESTAMP,
                version = orders.version + 1
            RETURNING *
        `;
        const values = [
            orderData.clientOrderId, orderData.brokerOrderId,
            orderData.strategyId, orderData.instrumentId,
            orderData.side, orderData.orderType || 'LIMIT',
            orderData.price, orderData.quantity,
            orderData.filledQuantity || 0, orderData.remainingQuantity || orderData.quantity,
            orderData.status || 'PENDING', orderData.brokerStatus,
            orderData.role, orderData.metadata || {},
            orderData.rawBrokerResponse,
            orderData.brokerOrderNumber, orderData.brokerClientCode,
            orderData.brokerExecutionId, orderData.brokerTransactionTime,
            orderData.isActive !== false,
            orderData.isWsConfirmed || false,
            orderData.isRestConfirmed || false,
        ];
        const result = await db.query(query, values);
        return result.rows[0];
    }

    async getOrderByClientId(clientOrderId) {
        const result = await db.query('SELECT * FROM orders WHERE client_order_id = $1', [clientOrderId]);
        return result.rows[0] || null;
    }

    async getOrderByBrokerId(brokerOrderId) {
        const result = await db.query('SELECT * FROM orders WHERE broker_order_id = $1', [brokerOrderId]);
        return result.rows[0] || null;
    }

    async getAllActiveOrders() {
        const result = await db.query(`
            SELECT * FROM orders 
            WHERE is_active = true 
            AND status IN ('PENDING', 'ACTIVE', 'PARTIALLY_FILLED')
            ORDER BY created_at DESC
        `);
        return result.rows;
    }

    async getActiveOrdersForStrategy(strategyId) {
        const result = await db.query(`
            SELECT * FROM orders 
            WHERE strategy_id = $1 
            AND is_active = true 
            AND status IN ('PENDING', 'ACTIVE', 'PARTIALLY_FILLED')
            ORDER BY created_at DESC
        `, [strategyId]);
        return result.rows;
    }

    async updateOrderStatus(clientOrderId, status, brokerStatus = null, data = null) {
        const isFinal = ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'REPLACING'].includes(status);
        const isFilled = status === 'FILLED';
        const isCancelled = status === 'CANCELLED' || status === 'REJECTED' || status === 'EXPIRED';
        const query = `
            UPDATE orders 
            SET status = $1,
                broker_status = COALESCE($2, broker_status),
                updated_at = CURRENT_TIMESTAMP,
                version = version + 1,
                raw_broker_response = COALESCE($3, raw_broker_response),
                is_ws_confirmed = CASE WHEN $4 THEN true ELSE is_ws_confirmed END,
                is_rest_confirmed = CASE WHEN $5 THEN true ELSE is_rest_confirmed END,
                confirmed_at = CASE WHEN $6 THEN CURRENT_TIMESTAMP ELSE confirmed_at END,
                filled_at = CASE WHEN $7 THEN CURRENT_TIMESTAMP ELSE filled_at END,
                cancelled_at = CASE WHEN $8 THEN CURRENT_TIMESTAMP ELSE cancelled_at END,
                is_active = CASE WHEN $9 THEN false ELSE is_active END
            WHERE client_order_id = $10
            RETURNING *
        `;
        const values = [
            status, brokerStatus,
            data ? JSON.stringify(data) : null,
            true, true,
            status === 'ACTIVE' || status === 'CONFIRMED',
            isFilled, isCancelled, isFinal,
            clientOrderId
        ];
        const result = await db.query(query, values);
        return result.rows[0] || null;
    }

    async addStatusHistory(orderId, status, brokerStatus, data, source = 'SYSTEM') {
        const query = `
            INSERT INTO order_status_history (
                order_id, status, broker_status, price, quantity,
                filled_quantity, remaining_quantity, error_message,
                raw_data, source
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `;
        const values = [
            orderId, status, brokerStatus,
            data?.price || null, data?.quantity || null,
            data?.filledQuantity || null, data?.remainingQuantity || null,
            data?.errorMessage || null,
            data ? JSON.stringify(data) : null,
            source
        ];
        await db.query(query, values);
    }

    async addLog(logData) {
        const query = `
            INSERT INTO logs (
                level, service, strategy_id, order_id, message,
                context, source_file, source_line, trace_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id
        `;
        const values = [
            logData.level, logData.service,
            logData.strategyId, logData.orderId,
            logData.message,
            logData.context ? JSON.stringify(logData.context) : null,
            logData.sourceFile, logData.sourceLine, logData.traceId
        ];
        const result = await db.query(query, values);
        return result.rows[0]?.id || null;
    }

    async searchOrders(filters) {
        let query = 'SELECT * FROM orders WHERE 1=1';
        const values = [];
        let paramIndex = 1;
        if (filters.strategyId) { query += ` AND strategy_id = $${paramIndex++}`; values.push(filters.strategyId); }
        if (filters.instrumentId) { query += ` AND instrument_id = $${paramIndex++}`; values.push(filters.instrumentId); }
        if (filters.status) { query += ` AND status = $${paramIndex++}`; values.push(filters.status); }
        if (filters.side) { query += ` AND side = $${paramIndex++}`; values.push(filters.side); }
        if (filters.role) { query += ` AND role = $${paramIndex++}`; values.push(filters.role); }
        if (filters.fromDate) { query += ` AND created_at >= $${paramIndex++}`; values.push(filters.fromDate); }
        if (filters.toDate) { query += ` AND created_at <= $${paramIndex++}`; values.push(filters.toDate); }
        if (filters.isActive !== undefined) { query += ` AND is_active = $${paramIndex++}`; values.push(filters.isActive); }
        if (filters.limit) { query += ` LIMIT $${paramIndex++}`; values.push(filters.limit); }
        if (filters.offset) { query += ` OFFSET $${paramIndex++}`; values.push(filters.offset); }
        const result = await db.query(query, values);
        return result.rows;
    }

    async getStrategyStats(strategyId) {
        const query = `
            SELECT 
                COUNT(*) as total_orders,
                COUNT(CASE WHEN status = 'FILLED' THEN 1 END) as filled_orders,
                COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) as cancelled_orders,
                COUNT(CASE WHEN status = 'ERROR' OR status = 'REJECTED' THEN 1 END) as error_orders,
                COUNT(CASE WHEN is_active = true AND status IN ('PENDING', 'ACTIVE', 'PARTIALLY_FILLED') THEN 1 END) as active_orders,
                COALESCE(SUM(filled_quantity), 0) as total_filled_quantity,
                COALESCE(AVG(price), 0) as avg_price
            FROM orders WHERE strategy_id = $1
        `;
        const result = await db.query(query, [strategyId]);
        return result.rows[0] || null;
    }
}

module.exports = new OrderDAO();
EOF

# ============================================================
# 30. SRC/SERVICES/AUTH.JS
# ============================================================
cat > src/services/auth.js << 'EOF'
const https = require('https');
const config = require('../config');

class AuthService {
    constructor() {
        this.accessToken = null;
        this.tokenExpiry = null;
        this.refreshToken = config.refreshToken;
        this.clientId = 'trade-api-write';
        this._tokenReceived = false;
        this._lastRefreshAttempt = null;
        this._refreshCount = 0;
        this._errors = [];
    }

    async getAccessToken() {
        if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
            return this.accessToken;
        }
        if (this.accessToken && this._tokenReceived) {
            return this.accessToken;
        }
        console.log('[Auth] 🔄 Fetching new token...');
        const result = await this.fetchToken();
        this.accessToken = result.access_token;
        const expiresIn = result.expires_in || 86400;
        this.tokenExpiry = Date.now() + (expiresIn * 1000);
        this._tokenReceived = true;
        this._lastRefreshAttempt = new Date();
        this._refreshCount++;
        console.log(`[Auth] ✅ Token received, expires in ${expiresIn}s`);
        return this.accessToken;
    }

    fetchToken() {
        return new Promise((resolve, reject) => {
            const postData = `client_id=${this.clientId}&grant_type=refresh_token&refresh_token=${this.refreshToken}`;
            const options = {
                hostname: new URL(config.baseUrl).hostname,
                path: '/trade-api-keycloak/realms/tradeapi/protocol/openid-connect/token',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(postData),
                },
            };
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.error) {
                            reject(new Error(`Auth error: ${json.error}`));
                            return;
                        }
                        if (!json.access_token) {
                            reject(new Error('No access_token in response'));
                            return;
                        }
                        resolve({
                            access_token: json.access_token,
                            expires_in: json.expires_in || 86400,
                            refresh_token: json.refresh_token,
                            token_type: json.token_type || 'Bearer'
                        });
                    } catch (e) {
                        reject(new Error(`Failed to parse response: ${e.message}`));
                    }
                });
            });
            req.on('error', (e) => reject(new Error(`Request failed: ${e.message}`)));
            req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timeout')); });
            req.write(postData);
            req.end();
        });
    }

    isTokenValid() {
        if (this.accessToken) {
            if (this.tokenExpiry) return Date.now() < (this.tokenExpiry - 300000);
            return this._tokenReceived;
        }
        return false;
    }

    getTimeUntilExpiry() {
        if (!this.tokenExpiry) return 86400;
        return Math.max(0, (this.tokenExpiry - Date.now()) / 1000);
    }

    getStats() {
        return {
            hasToken: !!this.accessToken,
            isTokenValid: this.isTokenValid(),
            expiresIn: this.getTimeUntilExpiry(),
            expiresInHours: (this.getTimeUntilExpiry() / 3600).toFixed(1),
            refreshCount: this._refreshCount,
            lastRefreshAttempt: this._lastRefreshAttempt ? this._lastRefreshAttempt.toISOString() : null,
            errors: this._errors.slice(-5),
            tokenPreview: this.accessToken ? this.accessToken.substring(0, 20) + '...' : null,
        };
    }
}

module.exports = new AuthService();
EOF

# ============================================================
# 31. SRC/SERVICES/REST-API.JS
# ============================================================
cat > src/services/rest-api.js << 'EOF'
const https = require('https');
const auth = require('./auth');
const config = require('../config');
const logger = require('../utils/logger');

class RestApiService {
    constructor() {
        this.stats = { totalRequests: 0, successfulRequests: 0, failedRequests: 0, totalTime: 0, minTime: Infinity, maxTime: 0, retries: 0, errors: [] };
        this._lastRequestId = 0;
    }

    async request(method, path, body = null) {
        const startTime = Date.now();
        this.stats.totalRequests++;
        const requestId = ++this._lastRequestId;
        logger.info(`[REST #${requestId}] ${method} ${path}`);

        try {
            const token = await auth.getAccessToken();
            const options = {
                hostname: new URL(config.baseUrl).hostname,
                path: path,
                method: method,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${token}`,
                },
            };

            return new Promise((resolve, reject) => {
                const req = https.request(options, (res) => {
                    let data = '';
                    res.on('data', (chunk) => { data += chunk; });
                    res.on('end', () => {
                        const duration = Date.now() - startTime;
                        this.updateStats(duration, true);
                        let parsedBody;
                        try { parsedBody = JSON.parse(data); } catch (e) { parsedBody = data; }
                        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsedBody });
                    });
                });
                req.on('error', (e) => {
                    const duration = Date.now() - startTime;
                    this.updateStats(duration, false, e.message);
                    reject(e);
                });
                req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timeout')); });
                if (body) { req.write(JSON.stringify(body)); }
                req.end();
            });
        } catch (e) { throw e; }
    }

    async requestWithRetry(method, path, body = null, retryCount = 0) {
        const maxRetries = config.maxRetries || 10;
        const retryDelay = config.retryDelay || 1.0;
        try {
            return await this.request(method, path, body);
        } catch (e) {
            if (retryCount >= maxRetries) throw e;
            this.stats.retries = (this.stats.retries || 0) + 1;
            await this.sleep(retryDelay * Math.pow(2, retryCount));
            return this.requestWithRetry(method, path, body, retryCount + 1);
        }
    }

    async createOrder(params) {
        const body = {
            clientOrderId: params.clientOrderId,
            side: params.side || '1',
            orderType: params.orderType || '2',
            orderQuantity: params.orderQuantity || 1,
            ticker: params.ticker || 'SBER',
            classCode: params.classCode || 'TQBR',
            price: params.price
        };
        const response = await this.requestWithRetry('POST', '/trade-api-bff-operations/api/v1/orders', body);
        return response.body;
    }

    async modifyOrder(params) {
        const body = {
            orderIdType: params.orderIdType || '1',
            orderId: params.orderId,
            clientOrderId: params.clientOrderId,
            orderType: params.orderType || '2',
            orderQuantity: params.orderQuantity || 1,
            price: params.price,
            ticker: params.ticker || 'SBER',
            classCode: params.classCode || 'TQBR'
        };
        const response = await this.requestWithRetry('POST', '/trade-api-bff-operations/api/v1/orders/edit', body);
        return response.body;
    }

    async cancelOrder(params) {
        const body = {
            orderIdType: params.orderIdType || '1',
            orderId: params.orderId,
            clientOrderId: params.clientOrderId
        };
        const response = await this.requestWithRetry('POST', '/trade-api-bff-operations/api/v1/orders/cancel', body);
        return response.body;
    }

    updateStats(duration, success, error = null) {
        if (success) {
            this.stats.successfulRequests++;
            this.stats.totalTime += duration;
            if (duration < this.stats.minTime) this.stats.minTime = duration;
            if (duration > this.stats.maxTime) this.stats.maxTime = duration;
        } else {
            this.stats.failedRequests++;
            if (error) {
                this.stats.errors.push({ time: new Date(), error });
                if (this.stats.errors.length > 100) this.stats.errors.shift();
            }
        }
    }

    sleep(seconds) { return new Promise(resolve => setTimeout(resolve, seconds * 1000)); }

    getStats() {
        const avgTime = this.stats.totalRequests > 0 ? this.stats.totalTime / this.stats.totalRequests : 0;
        return {
            totalRequests: this.stats.totalRequests,
            successfulRequests: this.stats.successfulRequests,
            failedRequests: this.stats.failedRequests,
            successRate: this.stats.totalRequests > 0 ? (this.stats.successfulRequests / this.stats.totalRequests * 100).toFixed(1) + '%' : '0%',
            avgTime: avgTime.toFixed(0) + 'ms',
            minTime: this.stats.minTime === Infinity ? 0 : this.stats.minTime + 'ms',
            maxTime: this.stats.maxTime + 'ms',
            retries: this.stats.retries || 0,
            lastErrors: this.stats.errors.slice(-5),
        };
    }
}

module.exports = new RestApiService();
EOF

# ============================================================
# 32. SRC/SERVICES/MARKET-DATA-PROVIDER.JS
# ============================================================
cat > src/services/market-data-provider.js << 'EOF'
const WebSocket = require('ws');
const config = require('../config');
const auth = require('./auth');
const logger = require('../utils/logger');
const EventEmitter = require('events');
const strategyConfig = require('../config/strategy');

class MarketDataProvider extends EventEmitter {
    constructor() {
        super();
        this.ws = null;
        this.isConnected = false;
        this.isSubscribed = false;
        this.orderBook = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = config.wsMaxReconnectAttempts || 10;
        this.messageCount = 0;
        this.lastUpdateTime = null;
        this.updateFrequency = 0;
        this._updateCounter = 0;
        this._lastFrequencyCheck = Date.now();
        this._firstDataReceived = false;
        this._lastDataReceived = null;
        this._isReconnecting = false;
        this.reconnectCooldown = 2000;
        this._lastReconnectAttempt = 0;
        this.reconnectTimer = null;
    }

    async connect() {
        if (this._isReconnecting) {
            return new Promise((resolve) => {
                const checkConnection = setInterval(() => {
                    if (!this._isReconnecting) {
                        clearInterval(checkConnection);
                        resolve(this.isConnected);
                    }
                }, 100);
            });
        }
        const now = Date.now();
        if (now - this._lastReconnectAttempt < this.reconnectCooldown) {
            await this.sleep((this.reconnectCooldown - (now - this._lastReconnectAttempt)) / 1000);
        }
        this._lastReconnectAttempt = now;
        const token = await auth.getAccessToken();
        return new Promise((resolve, reject) => {
            try {
                if (this.ws) {
                    try { this.ws.removeAllListeners(); this.ws.close(); } catch (e) {}
                    this.ws = null;
                }
                this._isReconnecting = true;
                this.ws = new WebSocket(config.wsMarketUrl, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                const connectTimeout = setTimeout(() => {
                    if (!this.isConnected) { this.ws.close(); this._isReconnecting = false; reject(new Error('Connection timeout')); }
                }, config.wsConnectTimeout || 10000);
                this.ws.on('open', () => {
                    clearTimeout(connectTimeout);
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    this._isReconnecting = false;
                    this._lastDataReceived = Date.now();
                    logger.wsLog('✅ Market WS Connected');
                    this.subscribe().then(() => resolve(true)).catch(() => resolve(true));
                });
                this.ws.on('message', (data) => { this.handleMessage(data); });
                this.ws.on('ping', () => { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.pong(); });
                this.ws.on('error', (error) => {
                    logger.wsLog(`❌ Market WS Error: ${error.message}`);
                    clearTimeout(connectTimeout);
                    if (!this.isConnected) { this._isReconnecting = false; reject(error); }
                });
                this.ws.on('close', () => {
                    clearTimeout(connectTimeout);
                    this.isConnected = false;
                    this.isSubscribed = false;
                    this._firstDataReceived = false;
                    this._isReconnecting = false;
                    logger.wsLog('⚠️ Market WS Disconnected');
                    this.emit('disconnected');
                    this.reconnect();
                });
            } catch (e) { this._isReconnecting = false; reject(e); }
        });
    }

    forceReconnect() {
        logger.wsLog('🔄 Force reconnecting...');
        this._firstDataReceived = false;
        this.orderBook = null;
        this.isSubscribed = false;
        if (this.ws) { try { this.ws.close(); } catch (e) {} this.ws = null; }
        return this.connect();
    }

    reconnect() {
        if (this._isReconnecting || this.reconnectAttempts >= this.maxReconnectAttempts) return;
        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
        logger.wsLog(`🔄 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(async () => {
            try { await this.forceReconnect(); this.reconnectAttempts = 0; this.emit('reconnected'); logger.ok('✅ Reconnected successfully'); }
            catch (e) { logger.wsLog(`❌ Reconnect failed: ${e.message}`); this.reconnect(); }
        }, delay);
    }

    hasValidData() {
        if (!this.orderBook || !this.orderBook.bids || !this.orderBook.asks ||
            this.orderBook.bids.length === 0 || this.orderBook.asks.length === 0) return false;
        if (this._lastDataReceived && Date.now() - this._lastDataReceived > 30000) return false;
        return true;
    }

    getOrderBook() {
        if (!this.hasValidData()) {
            if (this.isConnected && !this._isReconnecting) this.forceReconnect();
            return null;
        }
        return this.orderBook;
    }

    handleMessage(data) {
        try {
            const payload = JSON.parse(data.toString());
            this.messageCount++;
            this._updateCounter++;
            const now = Date.now();
            if (now - this._lastFrequencyCheck >= 1000) {
                this.updateFrequency = this._updateCounter;
                this._updateCounter = 0;
                this._lastFrequencyCheck = now;
            }
            if (payload.responseType === 'OrderBookSuccess') {
                logger.wsLog(`✅ Subscribed to ${payload.ticker} depth ${payload.depth}`);
                return;
            }
            if (payload.responseType === 'OrderBook') {
                if (!payload.bids || !payload.asks || payload.bids.length === 0 || payload.asks.length === 0) return;
                this.orderBook = {
                    ticker: payload.ticker,
                    classCode: payload.classCode,
                    depth: payload.depth,
                    dateTime: payload.dateTime,
                    bidVolume: payload.bidVolume,
                    askVolume: payload.askVolume,
                    bids: payload.bids || [],
                    asks: payload.asks || [],
                    spread: this.calculateSpread(payload)
                };
                this._lastDataReceived = Date.now();
                this.lastUpdateTime = new Date();
                if (!this._firstDataReceived) {
                    this._firstDataReceived = true;
                    logger.ok('✅ First market data received!');
                }
                this.emit('orderbook', this.orderBook);
            }
        } catch (e) { logger.wsLog(`❌ Market WS Parse error: ${e.message}`); }
    }

    disconnect() {
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        if (this.ws) { try { this.unsubscribe(); this.ws.close(); } catch (e) {} this.ws = null; }
        this.isConnected = false;
        this.isSubscribed = false;
        this._firstDataReceived = false;
        this._isReconnecting = false;
        logger.wsLog('🔌 Disconnected');
    }

    sleep(seconds) { return new Promise(resolve => setTimeout(resolve, seconds * 1000)); }

    async subscribe() {
        if (!this.isConnected) { throw new Error('Not connected'); }
        const message = {
            subscribeType: 0,
            dataType: 0,
            depth: 20,
            instruments: [{ ticker: strategyConfig.instrument.ticker, classCode: strategyConfig.instrument.classCode }]
        };
        try {
            this.ws.send(JSON.stringify(message));
            logger.wsLog(`📤 Subscribed to ${strategyConfig.instrument.ticker}/${strategyConfig.instrument.classCode}`);
            this.isSubscribed = true;
        } catch (e) { logger.wsLog(`❌ Subscribe error: ${e.message}`); throw e; }
    }

    unsubscribe() {
        if (!this.isConnected || !this.isSubscribed) return;
        const message = {
            subscribeType: 1,
            dataType: 0,
            instruments: [{ ticker: strategyConfig.instrument.ticker, classCode: strategyConfig.instrument.classCode }]
        };
        try { this.ws.send(JSON.stringify(message)); } catch (e) {}
        this.isSubscribed = false;
    }

    calculateSpread(payload) {
        if (!payload.bids || !payload.asks || !payload.bids.length || !payload.asks.length) return null;
        return payload.asks[0].price - payload.bids[0].price;
    }

    getMidPrice() {
        if (!this.hasValidData()) return null;
        return (this.orderBook.bids[0].price + this.orderBook.asks[0].price) / 2;
    }

    getStats() {
        const now = Date.now();
        return {
            isConnected: this.isConnected,
            isSubscribed: this.isSubscribed,
            hasData: this.hasValidData(),
            messageCount: this.messageCount,
            updateFrequency: this.updateFrequency,
            lastUpdateTime: this.lastUpdateTime,
            secondsSinceLastData: this._lastDataReceived ? ((now - this._lastDataReceived) / 1000).toFixed(1) : 'N/A',
            orderBook: this.orderBook,
            midPrice: this.getMidPrice(),
            spread: this.orderBook ? this.orderBook.spread : null,
            reconnectAttempts: this.reconnectAttempts,
            isReconnecting: this._isReconnecting,
        };
    }
}

module.exports = new MarketDataProvider();
EOF

# ============================================================
# 33. SRC/SERVICES/EXECUTION-REPORT-PROVIDER.JS
# ============================================================
cat > src/services/execution-report-provider.js << 'EOF'
const WebSocket = require('ws');
const config = require('../config');
const auth = require('./auth');
const logger = require('../utils/logger');
const EventEmitter = require('events');

class ExecutionReportProvider extends EventEmitter {
    constructor() {
        super();
        this.ws = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.messageCount = 0;
        this.transactions = new Map();
    }

    async connect() {
        try {
            const token = await auth.getAccessToken();
            return new Promise((resolve, reject) => {
                try {
                    this.ws = new WebSocket(config.wsTransactionsUrl, {
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    this.ws.on('open', () => {
                        this.isConnected = true;
                        this.reconnectAttempts = 0;
                        logger.wsLog('✅ Transactions WS Connected');
                        resolve();
                    });
                    this.ws.on('message', (data) => { this.handleMessage(data); });
                    this.ws.on('error', (error) => {
                        logger.wsLog(`❌ Transactions WS Error: ${error.message}`);
                        if (!this.isConnected) reject(error);
                    });
                    this.ws.on('close', () => {
                        this.isConnected = false;
                        logger.wsLog('⚠️ Transactions WS Disconnected');
                        this.reconnect();
                    });
                    setTimeout(() => { if (!this.isConnected) reject(new Error('Connection timeout')); }, 5000);
                } catch (e) { reject(e); }
            });
        } catch (e) {
            logger.wsLog(`❌ Transactions WS Connection failed: ${e.message}`);
            throw e;
        }
    }

    handleMessage(data) {
        try {
            const payload = JSON.parse(data.toString());
            this.messageCount++;
            const clientOrderId = payload.originalClientOrderId || payload.clientOrderId;
            if (!clientOrderId) return;
            this.transactions.set(clientOrderId, { ...payload.data, timestamp: new Date(), raw: payload });
            const orderStatus = payload.data?.orderStatus;
            const statusMap = {
                '0': 'orderCreated', '1': 'orderPartial', '2': 'orderFilled',
                '4': 'orderCancelled', '5': 'orderModified', '6': 'orderCancelling',
                '8': 'orderError', '9': 'orderModifying'
            };
            const eventType = statusMap[orderStatus];
            if (eventType) {
                this.emit(eventType, { clientOrderId, orderId: payload.data?.orderId, ...payload });
                logger.wsLog(`📨 ${eventType}: ${clientOrderId} (status: ${orderStatus})`);
            } else {
                this.emit('orderUpdate', payload);
            }
        } catch (e) { logger.wsLog(`❌ Transactions WS Parse error: ${e.message}`); }
    }

    getTransaction(orderId) { return this.transactions.get(orderId) || null; }

    reconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            logger.wsLog('❌ Max reconnect attempts reached');
            return;
        }
        this.reconnectAttempts++;
        const delay = Math.min(1000 * this.reconnectAttempts, 10000);
        logger.wsLog(`🔄 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
        setTimeout(async () => {
            try { await this.connect(); } catch (e) { logger.wsLog(`❌ Reconnect failed: ${e.message}`); }
        }, delay);
    }

    disconnect() {
        if (this.ws) { this.ws.close(); this.isConnected = false; logger.wsLog('🔌 Disconnected'); }
    }

    getStats() {
        return {
            isConnected: this.isConnected,
            messageCount: this.messageCount,
            transactionsCount: this.transactions.size
        };
    }
}

module.exports = new ExecutionReportProvider();
EOF

# ============================================================
# 34. SRC/SERVICES/PRICE-CALCULATOR.JS
# ============================================================
cat > src/services/price-calculator.js << 'EOF'
const strategyConfig = require('../config/strategy');

class PriceCalculator {
    static calculateOrderPrice(midPrice, offsetPercent = strategyConfig.priceOffsetPercent) {
        if (!midPrice || midPrice <= 0) throw new Error('Invalid midPrice');
        const price = midPrice * (1 - offsetPercent / 100);
        return Math.round(price * 100) / 100;
    }

    static calculateModifyPrice(midPrice) {
        return this.calculateOrderPrice(midPrice, strategyConfig.modifyOffsetPercent);
    }

    static shouldModify(currentPrice, newPrice, threshold = strategyConfig.modifyThreshold) {
        if (strategyConfig.forceModify) return true;
        if (!currentPrice || !newPrice) return false;
        return Math.abs(currentPrice - newPrice) >= threshold;
    }

    static getMidPrice(orderBook) {
        if (!orderBook || !orderBook.bids || !orderBook.asks ||
            !orderBook.bids.length || !orderBook.asks.length) return null;
        return (orderBook.bids[0].price + orderBook.asks[0].price) / 2;
    }

    static calculateSpread(orderBook) {
        if (!orderBook || !orderBook.bids || !orderBook.asks ||
            !orderBook.bids.length || !orderBook.asks.length) return null;
        return orderBook.asks[0].price - orderBook.bids[0].price;
    }
}

module.exports = PriceCalculator;
EOF

# ============================================================
# 35. SRC/SERVICES/INITIALIZER.JS
# ============================================================
cat > src/services/initializer.js << 'EOF'
const auth = require('./auth');
const restApi = require('./rest-api');
const marketData = require('./market-data-provider');
const transactionsWs = require('./execution-report-provider');
const config = require('../config');
const logger = require('../utils/logger');
const strategyRegistry = require('../strategies/registry');
const ConstantBidStrategy = require('../strategies/constant-bid-strategy');
const BcsAdapter = require('../adapters/bcs-adapter');
const db = require('../db');
const { OrderManager, ExecutionQueue, ExecutionEngine, ConditionEvaluator, RiskManager } = require('../core');

class Initializer {
    constructor() {
        this.initialized = false;
        this.state = {
            token: false, db: false, marketWs: false,
            transactionsWs: false, core: false, strategies: false
        };
        this.components = {
            brokerAdapter: null, orderManager: null, riskManager: null,
            executionQueue: null, executionEngine: null, conditionEvaluator: null
        };
        this._lastEmergencyStop = null;
    }

    async initialize() {
        logger.info('🚀 Starting initialization sequence...');
        logger.info('='.repeat(60));

        try {
            await this.initializeDatabase();
            await this.initializeToken();
            await this.initializeMarketWs();
            await this.initializeTransactionsWs();
            await this.initializeCore();
            await this.initializeStrategies();

            this.initialized = true;
            logger.info('='.repeat(60));
            logger.ok('✅ All components initialized successfully!');
            logger.info('ℹ️  Bot is in IDLE state. Press START to begin trading.');
            return true;
        } catch (error) {
            logger.err(`❌ Initialization failed: ${error.message}`);
            logger.err('='.repeat(60));
            return false;
        }
    }

    async initializeDatabase() {
        logger.info('🗄️ Step 1/6: Checking database...');
        try {
            if (!db.isConnected) await db.connect();
            this.state.db = true;
            logger.ok('✅ Database connected');
            return true;
        } catch (error) {
            logger.err(`❌ Database connection failed: ${error.message}`);
            return false;
        }
    }

    async initializeToken() {
        logger.info('🔐 Step 2/6: Getting access token...');
        if (!config.refreshToken) {
            logger.err('❌ REFRESH_TOKEN not set in .env');
            return false;
        }
        try {
            const token = await auth.getAccessToken();
            if (token) {
                this.state.token = true;
                logger.ok('✅ Access token received');
                return true;
            }
            return false;
        } catch (error) {
            logger.err(`❌ Failed to get token: ${error.message}`);
            return false;
        }
    }

    async initializeMarketWs() {
        logger.info('📡 Step 3/6: Connecting to Market WS...');
        try {
            await marketData.connect();
            this.state.marketWs = true;
            logger.ok('✅ Market WebSocket connected');
            return true;
        } catch (error) {
            logger.err(`❌ Market WS failed: ${error.message}`);
            return false;
        }
    }

    async initializeTransactionsWs() {
        logger.info('📡 Step 4/6: Connecting to Transactions WS...');
        try {
            await transactionsWs.connect();
            this.state.transactionsWs = true;
            logger.ok('✅ Transactions WebSocket connected');
            return true;
        } catch (error) {
            logger.err(`❌ Transactions WS failed: ${error.message}`);
            return false;
        }
    }

    async initializeCore() {
        logger.info('⚙️ Step 5/6: Initializing core components...');

        try {
            const brokerAdapter = new BcsAdapter(restApi);
            this.components.brokerAdapter = brokerAdapter;
            logger.ok('✅ Broker adapter initialized');

            const orderManager = new OrderManager({
                maxActiveOrders: 2,
                maxOrderValue: 100000,
                idempotencyTTL: 60000
            });
            orderManager.setBrokerAdapter(brokerAdapter);
            this.components.orderManager = orderManager;
            logger.ok('✅ Order Manager initialized');

            const riskManager = new RiskManager({
                dailyLossLimit: -10000,
                maxPosition: 1000,
                maxOrderRate: 10,
                maxOrderValue: 100000,
                maxConsecutiveErrors: 5
            });
            riskManager.start();
            this.components.riskManager = riskManager;
            logger.ok('✅ Risk Manager initialized');

            const executionQueue = new ExecutionQueue({ maxQueueSize: 1000 });
            this.components.executionQueue = executionQueue;
            logger.ok('✅ Execution Queue initialized');

            const executionEngine = new ExecutionEngine({
                timeout: 5000,
                maxRetries: 3,
                retryDelay: 1000,
                confirmationTimeout: 3000
            });
            executionEngine.setBrokerAdapter(brokerAdapter);
            executionEngine.setOrderManager(orderManager);
            executionEngine.setExecutionQueue(executionQueue);
            this.components.executionEngine = executionEngine;
            logger.ok('✅ Execution Engine initialized');

            const conditionEvaluator = new ConditionEvaluator(marketData);
            conditionEvaluator.setOrderManager(orderManager);
            this.components.conditionEvaluator = conditionEvaluator;

            conditionEvaluator.on('intent', (intent) => {
                logger.info(`[Evaluator] 📨 Received intent: ${intent.action} ${intent.symbol} @ ${intent.price}`);
                try {
                    const result = orderManager.processIntent(intent);
                    logger.info(`[Evaluator] Process result: ${JSON.stringify(result)}`);
                } catch (e) {
                    logger.err(`[Evaluator] Process intent error: ${e.message}`);
                }
            });

            conditionEvaluator.on('emergency_stop', (data) => {
                logger.err(`[Initializer] 🚨 EMERGENCY STOP`);
                this._lastEmergencyStop = data;
                this.stopBot();
            });

            orderManager.on('emergency_stop', (data) => {
                logger.err(`[Initializer] 🚨 Emergency stop from OrderManager`);
                this._lastEmergencyStop = data;
                this.stopBot();
            });

            orderManager.setRiskManager(riskManager);
            orderManager.setExecutionQueue(executionQueue);

            // Подключаем транзакции
            transactionsWs.on('orderCreated', (data) => {
                const event = this.parseWsEvent(data, 'CREATED');
                if (event) orderManager.syncWithWs(event);
            });
            transactionsWs.on('orderModified', (data) => {
                const event = this.parseWsEvent(data, 'MODIFIED');
                if (event) orderManager.syncWithWs(event);
            });
            transactionsWs.on('orderFilled', (data) => {
                const event = this.parseWsEvent(data, 'PARTIALLY_FILLED');
                if (event) orderManager.syncWithWs(event);
            });
            transactionsWs.on('orderCancelled', (data) => {
                const event = this.parseWsEvent(data, 'CANCELLED');
                if (event) orderManager.syncWithWs(event);
            });
            transactionsWs.on('orderError', (data) => {
                const event = this.parseWsEvent(data, 'ERROR');
                if (event) orderManager.syncWithWs(event);
            });

            executionEngine.on('execution_complete', (result) => {
                if (result.success && this.components.riskManager) {
                    this.components.riskManager.onExecutionReport({
                        status: result.status === 'CONFIRMED' ? 'FILLED' : 'ERROR',
                        filledQuantity: result.data?.quantity || 0,
                        filledPrice: result.data?.price || 0,
                        side: 'BUY',
                    });
                }
            });

            this.state.core = true;
            logger.ok('✅ Core components initialized');
            return true;
        } catch (error) {
            logger.err(`❌ Core initialization failed: ${error.message}`);
            return false;
        }
    }

    parseWsEvent(data, defaultStatus) {
        const clientOrderId = data.clientOrderId;
        if (!clientOrderId) return null;
        return {
            strategyId: 'default',
            clientOrderId,
            orderId: data.orderId || data.data?.orderId,
            status: data.data?.orderStatus || defaultStatus,
            price: data.data?.price || 0,
            quantity: data.data?.orderQuantity || 0,
            filledQuantity: data.data?.executedQuantity || 0,
            raw: data
        };
    }

    async initializeStrategies() {
        logger.info('📈 Step 6/6: Initializing strategies...');

        try {
            // Стратегия для SBER
            const sberStrategy = new ConstantBidStrategy({
                id: 'sber_bid',
                symbol: 'SBER',
                classCode: 'TQBR',
                offsetPercent: 1,
                quantity: 1,
                side: 'BUY',
                modifyThreshold: 0.05,
                minPrice: 0,
                maxPrice: 300,
            });
            sberStrategy.setOrderManager(this.components.orderManager);

            const sberCondition = (book) => {
                if (!book || !book.bids || !book.asks) return false;
                return book.bids.length > 0 && book.asks.length > 0;
            };

            strategyRegistry.setEvaluator(this.components.conditionEvaluator);
            strategyRegistry.register(sberStrategy, sberCondition);

            if (this.components.orderManager) {
                await this.components.orderManager.initializeAll([sberStrategy]);
            }

            this.state.strategies = true;
            const allStrategies = strategyRegistry.getAll();
            logger.ok(`✅ Registered ${allStrategies.length} strategies`);

            for (const strategy of allStrategies) {
                const info = strategy.getInfo();
                logger.info(`   📊 ${strategy.id}: ${strategy.symbol} (${info.type || 'constant-bid'})`);
            }

            return true;
        } catch (error) {
            logger.err(`❌ Strategy initialization failed: ${error.message}`);
            return false;
        }
    }

    startBot() {
        logger.info('[Initializer] 🔄 Starting bot...');
        if (this._lastEmergencyStop) {
            logger.info('[Initializer] Clearing emergency stop state');
            this._lastEmergencyStop = null;
        }
        if (!this.initialized) {
            logger.err('❌ Cannot start: system not initialized');
            return false;
        }
        const evaluator = this.components.conditionEvaluator;
        const engine = this.components.executionEngine;
        if (!evaluator || !engine) {
            logger.err('❌ Components not initialized');
            return false;
        }
        if (evaluator.isRunning) {
            logger.warn('⚠️ Bot already running');
            return true;
        }

        const strategies = strategyRegistry.getAll();
        for (const strategy of strategies) {
            if (strategy.start) strategy.start();
        }

        evaluator.start();
        engine.start();
        logger.ok('✅ Bot started!');
        return true;
    }

    stopBot() {
        logger.info('[Initializer] 🔄 Stopping bot...');
        const evaluator = this.components.conditionEvaluator;
        const engine = this.components.executionEngine;
        const strategies = strategyRegistry.getAll();

        for (const strategy of strategies) {
            if (strategy.stop) strategy.stop();
        }
        if (evaluator && evaluator.isRunning) evaluator.stop();
        if (engine && engine.executionQueue) engine.executionQueue.clear();

        logger.info('⏹️ Bot stopped');
        return true;
    }

    getStatus() {
        const evaluator = this.components.conditionEvaluator;
        const allStrategies = strategyRegistry.getAll();
        const activeStrategies = allStrategies.filter(s => s.isActive);

        return {
            initialized: this.initialized,
            state: this.state,
            isRunning: evaluator ? evaluator.isRunning : false,
            emergencyStop: this._lastEmergencyStop ? {
                reason: this._lastEmergencyStop.reason,
                timestamp: new Date().toISOString()
            } : null,
            strategies: {
                total: allStrategies.length,
                active: activeStrategies.length,
                list: allStrategies.map(s => ({
                    id: s.id,
                    symbol: s.symbol,
                    isActive: s.isActive || false,
                    metrics: s.metrics || {}
                }))
            },
            details: {
                tokenValid: auth.isTokenValid ? auth.isTokenValid() : false,
                marketConnected: marketData.isConnected || false,
                marketSubscribed: marketData.isSubscribed || false,
                transactionsConnected: transactionsWs.isConnected || false,
                dbConnected: db.isConnected || false,
            }
        };
    }

    isHealthy() {
        return this.initialized &&
            this.state.token &&
            this.state.db &&
            this.state.marketWs &&
            this.state.transactionsWs &&
            this.state.core &&
            this.state.strategies &&
            !this._lastEmergencyStop;
    }
}

module.exports = new Initializer();
EOF

# ============================================================
# 36. SRC/ROUTES/API.JS - ПОЛНАЯ ВЕРСИЯ
# ============================================================
cat > src/routes/api.js << 'EOF'
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const strategyRegistry = require('../strategies/registry');
const initializer = require('../services/initializer');
const db = require('../db');
const orderDAO = require('../db/order-dao');
const marketData = require('../services/market-data-provider');
const transactionsWs = require('../services/execution-report-provider');
const restApi = require('../services/rest-api');
const auth = require('../services/auth');

// ============================================================
// СТРАТЕГИИ
// ============================================================
router.get('/strategies', (req, res) => {
    try {
        const strategies = strategyRegistry.getInfo();
        res.json({ success: true, count: strategies.length, strategies });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/strategies/:id', (req, res) => {
    try {
        const strategy = strategyRegistry.get(req.params.id);
        if (!strategy) return res.status(404).json({ success: false, error: 'Strategy not found' });
        res.json({ success: true, strategy: strategy.getInfo() });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/strategies/:id/start', (req, res) => {
    try {
        const strategy = strategyRegistry.get(req.params.id);
        if (!strategy) return res.status(404).json({ success: false, error: 'Strategy not found' });
        if (strategy.start) strategy.start();
        res.json({ success: true, message: `Strategy ${req.params.id} started` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/strategies/:id/stop', (req, res) => {
    try {
        const strategy = strategyRegistry.get(req.params.id);
        if (!strategy) return res.status(404).json({ success: false, error: 'Strategy not found' });
        if (strategy.stop) strategy.stop();
        res.json({ success: true, message: `Strategy ${req.params.id} stopped` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/strategies/:id/orders', async (req, res) => {
    try {
        const orders = await orderDAO.getActiveOrdersForStrategy(req.params.id);
        res.json({ success: true, count: orders.length, orders });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/strategies/:id/history', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const orders = await orderDAO.searchOrders({ strategyId: req.params.id, limit, isActive: false });
        res.json({ success: true, count: orders.length, orders });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/strategies/:id/stats', async (req, res) => {
    try {
        const stats = await orderDAO.getStrategyStats(req.params.id);
        res.json({ success: true, stats: stats || { total_orders: 0, filled_orders: 0, cancelled_orders: 0, error_orders: 0, active_orders: 0 } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// ЗАЯВКИ
// ============================================================
router.get('/orders/active', async (req, res) => {
    try {
        const orders = await orderDAO.getAllActiveOrders();
        res.json({ success: true, count: orders.length, orders });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/orders/:id', async (req, res) => {
    try {
        let order = await orderDAO.getOrderByClientId(req.params.id);
        if (!order) order = await orderDAO.getOrderByBrokerId(req.params.id);
        if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
        res.json({ success: true, order });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// УПРАВЛЕНИЕ БОТОМ
// ============================================================
router.post('/start', (req, res) => {
    try {
        const result = initializer.startBot();
        res.json({ success: result, message: result ? 'Bot started' : 'Failed to start' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/stop', (req, res) => {
    try {
        initializer.stopBot();
        res.json({ success: true, message: 'Bot stopped' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// СТАТУС И ЗДОРОВЬЕ
// ============================================================
router.get('/status', (req, res) => {
    try {
        const status = initializer.getStatus();
        const allStrategies = strategyRegistry.getAll();
        res.json({
            success: true,
            version: '4.0.0',
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            initializer: status,
            strategies: allStrategies.map(s => ({
                id: s.id,
                symbol: s.symbol,
                isActive: s.isActive || false,
                metrics: s.metrics || {}
            })),
            db: db.isConnected ? 'connected' : 'disconnected',
            timestamp: new Date().toISOString()
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/health', (req, res) => {
    const status = initializer.getStatus ? initializer.getStatus() : {};
    res.json({
        success: true,
        status: 'ok',
        version: '4.0.0',
        initialized: initializer.initialized || false,
        isHealthy: initializer.isHealthy ? initializer.isHealthy() : false,
        uptime: process.uptime(),
        strategies: status.strategies || { total: 0, active: 0 },
        db: db.isConnected ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString()
    });
});

// ============================================================
// СТАТИСТИКА
// ============================================================
router.get('/stats', (req, res) => {
    try {
        const strategies = strategyRegistry.getInfo();
        res.json({
            success: true,
            totalStrategies: strategies.length,
            activeStrategies: strategies.filter(s => s.info.state?.isActive).length,
            strategies,
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            timestamp: new Date().toISOString()
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/stats/rest', (req, res) => {
    try { res.json(restApi.getStats()); } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/stats/market', (req, res) => {
    try { res.json(marketData.getStats()); } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/stats/transactions', (req, res) => {
    try { res.json(transactionsWs.getStats()); } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============================================================
// РЫНОЧНЫЕ ДАННЫЕ
// ============================================================
router.get('/orderbook', (req, res) => {
    try {
        const book = marketData.getOrderBook();
        if (book) res.json({ success: true, orderbook: book });
        else res.json({ success: false, error: 'No orderbook data' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// АУТЕНТИФИКАЦИЯ
// ============================================================
router.get('/auth/status', (req, res) => {
    try { res.json({ success: true, ...auth.getStats() }); } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/auth/refresh', async (req, res) => {
    try {
        await auth.fetchToken();
        res.json({ success: true, message: 'Token refreshed', stats: auth.getStats() });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// РИСК-МЕНЕДЖЕР
// ============================================================
router.get('/risk/status', (req, res) => {
    try {
        const comps = initializer.components || {};
        const riskManager = comps.riskManager;
        if (!riskManager) return res.status(500).json({ success: false, error: 'RiskManager not initialized' });
        res.json({ success: true, state: riskManager.getState(), config: riskManager.getConfig() });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/risk/reset-circuit-breaker', (req, res) => {
    try {
        const comps = initializer.components || {};
        const riskManager = comps.riskManager;
        if (!riskManager) return res.status(500).json({ success: false, error: 'RiskManager not initialized' });
        riskManager.resetCircuitBreaker();
        res.json({ success: true, message: 'Circuit breaker reset' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
EOF

# ============================================================
# 37. SRC/PUBLIC/INDEX.HTML
# ============================================================
cat > src/public/index.html << 'EOF'
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🤖 Trading Bot v4.0</title>
    <link rel="stylesheet" href="css/style.css">
</head>
<body>
    <div class="container">
        <header class="header">
            <div>
                <h1>🤖 TRADING BOT <span class="version">v4.0</span></h1>
                <span class="subtitle">Multi-Strategy Platform</span>
            </div>
            <div class="header-controls">
                <span class="status-badge" id="statusBadge">● IDLE</span>
                <span class="uptime" id="uptime">⏱ 0s</span>
                <button class="btn btn-refresh" onclick="refreshData()">⟳ REFRESH</button>
            </div>
        </header>

        <section class="stats-row" id="globalStats">
            <div class="stat-item"><span class="stat-value green" id="statStrategies">0</span><span class="stat-label">Strategies</span></div>
            <div class="stat-item"><span class="stat-value green" id="statActive">0</span><span class="stat-label">Active</span></div>
            <div class="stat-item"><span class="stat-value blue" id="statPending">0</span><span class="stat-label">Pending</span></div>
            <div class="stat-item"><span class="stat-value green" id="statFilled">0</span><span class="stat-label">Filled</span></div>
            <div class="stat-item"><span class="stat-value red" id="statErrors">0</span><span class="stat-label">Errors</span></div>
            <div class="stat-item"><span class="stat-value yellow" id="statQueue">0</span><span class="stat-label">Queue</span></div>
        </section>

        <section class="tabs-section">
            <div class="tabs-header" id="tabsHeader"></div>
            <div class="tab-content" id="tabContent"></div>
        </section>

        <section class="card">
            <div class="card-title">📝 GLOBAL LOG</div>
            <div class="log" id="log"><div class="log-line info">[System] Trading Bot v4.0 ready</div></div>
        </section>

        <footer class="footer"><span id="timestamp">Last update: —</span><span>🤖 v4.0 • Multi-Strategy</span></footer>
    </div>
    <script src="js/app.js"></script>
</body>
</html>
EOF

# ============================================================
# 38. SRC/PUBLIC/CSS/STYLE.CSS
# ============================================================
cat > src/public/css/style.css << 'EOF'
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Courier New', monospace; background: #0a0a0a; color: #e0e0e0; padding: 20px; font-size: 14px; }
.container { max-width: 1600px; margin: 0 auto; }
.header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #1f2937; padding-bottom: 15px; margin-bottom: 20px; flex-wrap: wrap; gap: 10px; }
.header h1 { font-size: 22px; color: #fff; }
.version { color: #9ca3af; font-size: 14px; margin-left: 10px; }
.subtitle { color: #9ca3af; font-size: 12px; display: block; }
.header-controls { display: flex; align-items: center; gap: 15px; flex-wrap: wrap; }
.status-badge { font-size: 16px; font-weight: bold; padding: 6px 18px; border: 2px solid #9ca3af; border-radius: 4px; }
.status-badge.running { color: #4ade80; border-color: #4ade80; }
.status-badge.stopped { color: #9ca3af; border-color: #9ca3af; }
.status-badge.idle { color: #60a5fa; border-color: #60a5fa; }
.uptime { color: #9ca3af; font-size: 14px; }
.btn { padding: 8px 20px; border: 2px solid #9ca3af; background: transparent; color: #fff; cursor: pointer; font-family: inherit; font-size: 13px; border-radius: 4px; transition: all 0.2s; }
.btn:hover:not(:disabled) { background: #fff; color: #000; }
.btn:disabled { opacity: 0.3; cursor: not-allowed; }
.btn-start { border-color: #4ade80; color: #4ade80; }
.btn-start:hover:not(:disabled) { background: #4ade80; color: #000; }
.btn-stop { border-color: #f87171; color: #f87171; }
.btn-stop:hover:not(:disabled) { background: #f87171; color: #000; }
.btn-refresh { border-color: #60a5fa; color: #60a5fa; }
.btn-refresh:hover:not(:disabled) { background: #60a5fa; color: #000; }
.btn-sm { padding: 4px 12px; font-size: 11px; }
.stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin-bottom: 20px; }
.stat-item { border: 2px solid #1f2937; padding: 12px 16px; text-align: center; border-radius: 4px; background: #0f0f0f; }
.stat-value { display: block; font-size: 22px; font-weight: bold; }
.stat-value.green { color: #4ade80; }
.stat-value.red { color: #f87171; }
.stat-value.blue { color: #60a5fa; }
.stat-value.yellow { color: #fbbf24; }
.stat-label { font-size: 11px; color: #9ca3af; text-transform: uppercase; letter-spacing: 1px; }
.tabs-section { margin-bottom: 20px; }
.tabs-header { display: flex; gap: 4px; border-bottom: 2px solid #1f2937; margin-bottom: 16px; flex-wrap: wrap; }
.tab-btn { padding: 10px 24px; background: transparent; border: none; color: #9ca3af; cursor: pointer; font-family: inherit; font-size: 14px; border-bottom: 3px solid transparent; transition: all 0.2s; position: relative; }
.tab-btn:hover { color: #fff; background: #1a1a1a; }
.tab-btn.active { color: #fff; border-bottom-color: #60a5fa; }
.tab-btn .badge { position: absolute; top: -6px; right: -6px; font-size: 10px; padding: 1px 6px; border-radius: 10px; font-weight: bold; }
.tab-btn .badge.active-badge { background: #4ade80; color: #000; }
.tab-btn .badge.inactive-badge { background: #f87171; color: #000; }
.tab-content { min-height: 200px; }
.tab-panel { display: none; }
.tab-panel.active { display: block; }
.card { border: 2px solid #1f2937; background: #0f0f0f; padding: 18px; border-radius: 4px; margin-bottom: 16px; }
.card-title { font-size: 16px; font-weight: bold; color: #fff; margin-bottom: 12px; border-bottom: 1px solid #1f2937; padding-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
.card-title .count { font-size: 12px; color: #9ca3af; font-weight: normal; }
.strategy-info { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 16px; padding: 12px; background: #0a0a0a; border-radius: 4px; }
.strategy-info .info-item { text-align: center; }
.strategy-info .info-label { font-size: 10px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.5px; }
.strategy-info .info-value { font-size: 16px; font-weight: bold; color: #fff; }
.strategy-controls { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.order-list { max-height: 300px; overflow-y: auto; }
.order-item { display: flex; justify-content: space-between; padding: 6px 8px; border-bottom: 1px solid #1f2937; font-size: 13px; align-items: center; flex-wrap: wrap; gap: 4px; }
.order-item .status { padding: 2px 10px; border-radius: 3px; font-size: 11px; font-weight: bold; }
.order-item .status.active { color: #4ade80; border: 1px solid #4ade80; }
.order-item .status.pending { color: #fbbf24; border: 1px solid #fbbf24; }
.order-item .status.cancelled { color: #f87171; border: 1px solid #f87171; }
.order-item .status.error { color: #f87171; border: 1px solid #f87171; }
.order-item .status.filled { color: #60a5fa; border: 1px solid #60a5fa; }
.order-item .status.replaced { color: #a78bfa; border: 1px solid #a78bfa; }
.order-item .role-badge { font-size: 10px; padding: 1px 8px; border-radius: 10px; background: #1f2937; color: #9ca3af; }
.order-item .role-badge.bid { background: #1a3a2a; color: #4ade80; }
.order-item .role-badge.ask { background: #3a1a1a; color: #f87171; }
.empty-state { color: #9ca3af; text-align: center; padding: 16px; font-size: 14px; }
.log { max-height: 150px; overflow-y: auto; font-size: 12px; font-family: 'Courier New', monospace; background: #0a0a0a; border: 1px solid #1f2937; padding: 10px; border-radius: 4px; }
.log-line { padding: 1px 0; font-size: 12px; }
.log-line.info { color: #d1d5db; }
.log-line.success { color: #4ade80; }
.log-line.error { color: #f87171; }
.log-line.warning { color: #fbbf24; }
.footer { margin-top: 20px; border-top: 2px solid #1f2937; padding-top: 12px; font-size: 13px; color: #9ca3af; display: flex; justify-content: space-between; flex-wrap: wrap; }
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: #0a0a0a; }
::-webkit-scrollbar-thumb { background: #4a4a4a; border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: #6a6a6a; }
@media (max-width: 768px) { .header { flex-direction: column; align-items: flex-start; } .stats-row { grid-template-columns: repeat(3, 1fr); } .tab-btn { padding: 8px 12px; font-size: 12px; } }
EOF

# ============================================================
# 39. SRC/PUBLIC/JS/APP.JS
# ============================================================
cat > src/public/js/app.js << 'EOF'
const CONFIG = { BASE_PATH: window.location.pathname.startsWith('/bot') ? '/bot' : '', UPDATE_INTERVAL: 1000, MAX_LOG_LINES: 100 };
const API = { get BASE_URL() { return CONFIG.BASE_PATH + '/api'; } };
const DOM = {};

function cacheDom() {
    DOM.statusBadge = document.getElementById('statusBadge');
    DOM.uptime = document.getElementById('uptime');
    DOM.statStrategies = document.getElementById('statStrategies');
    DOM.statActive = document.getElementById('statActive');
    DOM.statPending = document.getElementById('statPending');
    DOM.statFilled = document.getElementById('statFilled');
    DOM.statErrors = document.getElementById('statErrors');
    DOM.statQueue = document.getElementById('statQueue');
    DOM.tabsHeader = document.getElementById('tabsHeader');
    DOM.tabContent = document.getElementById('tabContent');
    DOM.log = document.getElementById('log');
    DOM.timestamp = document.getElementById('timestamp');
}

async function apiCall(endpoint, options = {}) {
    try {
        const resp = await fetch(API.BASE_URL + endpoint, {
            ...options,
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        return data;
    } catch (e) { console.error('API Error:', e.message); throw e; }
}

function renderStrategies(strategies) {
    if (!strategies || strategies.length === 0) {
        DOM.tabsHeader.innerHTML = '<div class="empty-state">No strategies registered</div>';
        DOM.tabContent.innerHTML = '';
        return;
    }
    let tabsHtml = '', panelsHtml = '';
    strategies.forEach((strategy, index) => {
        const isActive = strategy.info?.state?.isActive || false;
        const isFirst = index === 0;
        const activeClass = isFirst ? 'active' : '';
        const info = strategy.info || {};
        tabsHtml += `<button class="tab-btn ${activeClass}" data-strategy="${strategy.id}" onclick="switchTab('${strategy.id}')">
            ${info.symbol || strategy.id}
            <span class="badge ${isActive ? 'active-badge' : 'inactive-badge'}">${isActive ? '●' : '○'}</span>
        </button>`;
        panelsHtml += `<div class="tab-panel ${activeClass}" id="panel-${strategy.id}">
            <div class="strategy-panel" data-strategy="${strategy.id}">
                ${renderStrategyPanel(strategy)}
            </div>
        </div>`;
    });
    DOM.tabsHeader.innerHTML = tabsHtml;
    DOM.tabContent.innerHTML = panelsHtml;
    strategies.forEach(s => loadStrategyData(s.id));
}

function renderStrategyPanel(strategy) {
    const info = strategy.info || {};
    const isActive = info.state?.isActive || false;
    const params = info.params || {};
    const state = info.state || {};
    return `
        <div class="strategy-info">
            <div class="info-item"><div class="info-label">Strategy</div><div class="info-value">${strategy.id}</div></div>
            <div class="info-item"><div class="info-label">Symbol</div><div class="info-value">${info.symbol || 'N/A'}</div></div>
            <div class="info-item"><div class="info-label">Type</div><div class="info-value">${info.type || 'unknown'}</div></div>
            <div class="info-item"><div class="info-label">Status</div><div class="info-value" style="color:${isActive ? '#4ade80' : '#9ca3af'}">${isActive ? 'RUNNING' : 'STOPPED'}</div></div>
            <div class="info-item"><div class="info-label">Calls</div><div class="info-value">${info.metrics?.calls || 0}</div></div>
            <div class="info-item"><div class="info-label">Intents</div><div class="info-value">${info.metrics?.intentsGenerated || 0}</div></div>
        </div>
        <div class="strategy-controls">
            ${isActive ? `<button class="btn btn-stop btn-sm" onclick="stopStrategy('${strategy.id}')">■ STOP</button>` :
                        `<button class="btn btn-start btn-sm" onclick="startStrategy('${strategy.id}')">▶ START</button>`}
            <button class="btn btn-refresh btn-sm" onclick="loadStrategyData('${strategy.id}')">⟳ REFRESH</button>
        </div>
        <div class="card"><div class="card-title">🟢 ACTIVE ORDERS <span class="count" id="activeCount-${strategy.id}">(0)</span></div>
            <div class="order-list" id="activeOrders-${strategy.id}"><div class="empty-state">Loading...</div></div>
        </div>
        <div class="card"><div class="card-title">📜 ORDER HISTORY <span class="count" id="historyCount-${strategy.id}">(0)</span></div>
            <div class="order-list" id="orderHistory-${strategy.id}"><div class="empty-state">Loading...</div></div>
        </div>
        <div class="card"><div class="card-title">📊 STATISTICS</div>
            <div class="stats-row" id="strategyStats-${strategy.id}">
                <div class="stat-item"><span class="stat-value green" id="statTotalOrders-${strategy.id}">0</span><span class="stat-label">Total</span></div>
                <div class="stat-item"><span class="stat-value green" id="statFilledOrders-${strategy.id}">0</span><span class="stat-label">Filled</span></div>
                <div class="stat-item"><span class="stat-value red" id="statCancelledOrders-${strategy.id}">0</span><span class="stat-label">Cancelled</span></div>
                <div class="stat-item"><span class="stat-value yellow" id="statAvgPrice-${strategy.id}">0</span><span class="stat-label">Avg Price</span></div>
            </div>
        </div>
    `;
}

async function loadStrategyData(strategyId) {
    try {
        const ordersResp = await apiCall(`/strategies/${strategyId}/orders`);
        const historyResp = await apiCall(`/strategies/${strategyId}/history?limit=30`);
        const statsResp = await apiCall(`/strategies/${strategyId}/stats`);

        const activeOrders = ordersResp.orders || [];
        const activeContainer = document.getElementById(`activeOrders-${strategyId}`);
        const activeCount = document.getElementById(`activeCount-${strategyId}`);
        activeCount.textContent = `(${activeOrders.length})`;
        activeContainer.innerHTML = activeOrders.length === 0 ? '<div class="empty-state">No active orders</div>' :
            activeOrders.map(o => `<div class="order-item"><span>${o.client_order_id ? o.client_order_id.slice(0, 12) + '...' : '—'}</span>
                <span>${o.price ? o.price.toFixed(2) : '—'}</span><span>${o.quantity || 0}</span>
                <span class="role-badge ${o.role ? o.role.toLowerCase() : ''}">${o.role || '—'}</span>
                <span class="status ${o.status ? o.status.toLowerCase() : 'pending'}">${o.status || 'PENDING'}</span>
            </div>`).join('');

        const historyOrders = historyResp.orders || [];
        const historyContainer = document.getElementById(`orderHistory-${strategyId}`);
        const historyCount = document.getElementById(`historyCount-${strategyId}`);
        historyCount.textContent = `(${historyOrders.length})`;
        historyContainer.innerHTML = historyOrders.length === 0 ? '<div class="empty-state">No history yet</div>' :
            historyOrders.slice(0, 20).map(o => `<div class="order-item"><span>${o.client_order_id ? o.client_order_id.slice(0, 12) + '...' : '—'}</span>
                <span>${o.price ? o.price.toFixed(2) : '—'}</span><span>${o.quantity || 0}</span>
                <span class="status ${o.status ? o.status.toLowerCase() : 'pending'}">${o.status || 'PENDING'}</span>
                <span style="font-size:10px;color:#9ca3af;">${new Date(o.created_at).toLocaleTimeString()}</span>
            </div>`).join('');

        const stats = statsResp.stats || {};
        document.getElementById(`statTotalOrders-${strategyId}`).textContent = stats.total_orders || 0;
        document.getElementById(`statFilledOrders-${strategyId}`).textContent = stats.filled_orders || 0;
        document.getElementById(`statCancelledOrders-${strategyId}`).textContent = stats.cancelled_orders || 0;
        document.getElementById(`statAvgPrice-${strategyId}`).textContent = stats.avg_price ? stats.avg_price.toFixed(2) : '0';
    } catch (e) { console.error(`Error loading data for ${strategyId}:`, e); }
}

function switchTab(strategyId) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.strategy === strategyId));
    document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === `panel-${strategyId}`));
}

async function startStrategy(strategyId) {
    try { await apiCall(`/strategies/${strategyId}/start`, { method: 'POST' }); addLog(`Strategy ${strategyId} started`, 'success'); refreshData(); }
    catch (e) { addLog(`Failed to start ${strategyId}: ${e.message}`, 'error'); }
}

async function stopStrategy(strategyId) {
    try { await apiCall(`/strategies/${strategyId}/stop`, { method: 'POST' }); addLog(`Strategy ${strategyId} stopped`, 'warning'); refreshData(); }
    catch (e) { addLog(`Failed to stop ${strategyId}: ${e.message}`, 'error'); }
}

async function refreshData() {
    try {
        const data = await apiCall('/strategies');
        if (data.success) {
            renderStrategies(data.strategies);
            updateGlobalStats(data.strategies);
        }
        DOM.timestamp.textContent = 'Last update: ' + new Date().toLocaleTimeString();
    } catch (e) { console.error('Refresh error:', e); }
}

function updateGlobalStats(strategies) {
    const active = strategies.filter(s => s.info?.state?.isActive).length;
    DOM.statStrategies.textContent = strategies.length;
    DOM.statActive.textContent = active;
    DOM.statusBadge.textContent = active > 0 ? '● RUNNING' : '● IDLE';
    DOM.statusBadge.className = `status-badge ${active > 0 ? 'running' : 'idle'}`;
    DOM.uptime.textContent = '⏱ ' + Math.floor(process.uptime() || 0) + 's';
}

function addLog(msg, type = 'info') {
    const el = DOM.log;
    const line = document.createElement('div');
    line.className = 'log-line ' + type;
    line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
    while (el.children.length > CONFIG.MAX_LOG_LINES) el.removeChild(el.firstChild);
}

function init() {
    cacheDom();
    addLog('Trading Bot v4.0 ready', 'info');
    refreshData();
    setInterval(refreshData, CONFIG.UPDATE_INTERVAL);
    setInterval(() => { DOM.uptime.textContent = '⏱ ' + Math.floor(process.uptime() || 0) + 's'; }, 1000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
EOF

# ============================================================
# 40. SRC/PUBLIC/JS/STATS.JS
# ============================================================
cat > src/public/js/stats.js << 'EOF'
const CONFIG = { BASE_PATH: window.location.pathname.startsWith('/bot') ? '/bot' : '', UPDATE_INTERVAL: 2000 };
const API = { get BASE_URL() { return CONFIG.BASE_PATH + '/api'; } };

async function apiCall(endpoint) {
    try { const resp = await fetch(API.BASE_URL + endpoint); const data = await resp.json(); if (!resp.ok) throw new Error(data.error); return data; }
    catch (e) { console.error('API Error:', e.message); return null; }
}

async function updateStats() {
    try {
        const data = await apiCall('/stats');
        if (!data) return;
        document.getElementById('totalStrategies').textContent = data.totalStrategies || 0;
        document.getElementById('activeStrategies').textContent = data.activeStrategies || 0;
        document.getElementById('uptime').textContent = Math.floor(data.uptime || 0) + 's';
        document.getElementById('memory').textContent = Math.round((data.memory?.heapUsed || 0) / 1024 / 1024) + 'MB';
        document.getElementById('timestamp').textContent = 'Last update: ' + new Date().toLocaleTimeString();
    } catch (e) { console.error('Update error:', e); }
}

function init() { updateStats(); setInterval(updateStats, CONFIG.UPDATE_INTERVAL); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
EOF

# ============================================================
# 41. SRC/PUBLIC/STATS.HTML
# ============================================================
cat > src/public/stats.html << 'EOF'
<!DOCTYPE html>
<html lang="ru">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>📊 Trading Bot v4.0 - Statistics</title>
<link rel="stylesheet" href="css/style.css">
</head>
<body>
<div class="container"><header class="header"><div><a href="." class="back-link" style="color:#60a5fa;text-decoration:none;">← Back</a><h1>📊 STATISTICS</h1></div>
<div class="header-controls"><span class="live-badge" style="color:#4ade80;font-weight:bold;">● LIVE</span><button class="btn btn-refresh" onclick="updateStats()">⟳ REFRESH</button></div></header>
<section class="stats-row">
<div class="stat-item"><span class="stat-value green" id="totalStrategies">0</span><span class="stat-label">Strategies</span></div>
<div class="stat-item"><span class="stat-value green" id="activeStrategies">0</span><span class="stat-label">Active</span></div>
<div class="stat-item"><span class="stat-value yellow" id="uptime">0s</span><span class="stat-label">Uptime</span></div>
<div class="stat-item"><span class="stat-value blue" id="memory">0MB</span><span class="stat-label">Memory</span></div>
</section>
<footer class="footer"><span>Auto-update every 2s</span><span id="timestamp">Last update: —</span></footer>
</div>
<script src="js/stats.js"></script>
</body>
</html>
EOF

# ============================================================
# ФИНАЛЬНЫЙ ВЫВОД
# ============================================================
echo ""
echo "✅ ПОЛНЫЙ ПРОЕКТ V4.0 СОЗДАН!"
echo "============================================================"
echo ""
echo "📁 Структура проекта:"
find src -type f \( -name "*.js" -o -name "*.html" -o -name "*.css" \) ! -path "*/node_modules/*" | sort | sed 's/^/  /'
echo ""
echo "📊 Количество файлов: $(find src -type f -name "*.js" | wc -l) JS файлов"
echo ""
echo "🚀 ДЛЯ ЗАПУСКА:"
echo "  1. cp .env.example .env"
echo "  2. Заполните .env (BCS_REFRESH_TOKEN и DB_PASSWORD обязательны)"
echo "  3. sudo apt-get install postgresql postgresql-contrib"
echo "  4. sudo -u postgres psql -c \"CREATE DATABASE trading_bot;\""
echo "  5. sudo -u postgres psql -c \"CREATE USER trading_bot WITH PASSWORD 'secure_password';\""
echo "  6. sudo -u postgres psql -c \"GRANT ALL PRIVILEGES ON DATABASE trading_bot TO trading_bot;\""
echo "  7. npm install"
echo "  8. npm run db:init"
echo "  9. npm start"
echo ""
echo "📡 API: http://localhost:3001/bot/api/"
echo "   - GET /strategies - список стратегий"
echo "   - GET /status - статус бота"
echo "   - POST /start - запуск бота"
echo "   - POST /stop - остановка бота"
echo ""
echo "🌐 WEB: http://localhost:3001/bot/"
echo "   - Вкладки для каждой стратегии"
echo "   - Управление стратегиями"
echo "   - Просмотр заявок и статистики"
echo ""
echo "🗄️ PostgreSQL:"
echo "   Database: trading_bot"
echo "   User: trading_bot"
echo "   Password: secure_password (измените в .env)"
echo ""
echo "============================================================"
echo "✅ ПРОЕКТ ГОТОВ К РАБОТЕ!"