# ============================================================
# SRC/INDEX.JS - ТОЧКА ВХОДА (ГЛАВНЫЙ ФАЙЛ!)
# ============================================================
cat > src/index.js << 'EOF'
// Точка входа v4.0
const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const apiRoutes = require('./routes/api');
const logger = require('./utils/logger');
const db = require('./db');

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

// Health check
app.get(`${basePath}/health`, (req, res) => {
    res.json({
        status: 'ok',
        version: '4.0.0',
        initialized: false,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        pid: process.pid,
        memory: process.memoryUsage(),
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
    // Подключаемся к БД
    try {
        await db.connect();
        logger.ok('✅ Database connected');
    } catch (error) {
        logger.err(`❌ Database connection failed: ${error.message}`);
        logger.warn('⚠️ Bot will start without database');
    }

    server = app.listen(port, '0.0.0.0', () => {
        console.log('='.repeat(60));
        console.log('🤖 TRADING BOT v4.0');
        console.log('='.repeat(60));
        console.log(`📡 Server: http://localhost:${port}${basePath}`);
        console.log(`❤️  Health: http://localhost:${port}${basePath}/health`);
        console.log('='.repeat(60));
        console.log('Press Ctrl+C to stop');
        console.log('='.repeat(60));
    });
}

async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n🛑 Received ${signal}, starting graceful shutdown...`);

    const forceExitTimeout = setTimeout(() => {
        console.error('❌ Shutdown timeout (15s), forcing exit...');
        process.exit(1);
    }, 15000);

    try {
        console.log('🔌 Closing HTTP server...');
        if (server) {
            await new Promise((resolve, reject) => {
                server.close((err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            console.log('✅ HTTP server closed');
        }

        console.log('🔌 Disconnecting from database...');
        await db.disconnect();
        console.log('✅ Database disconnected');

        console.log('📝 Closing logs...');
        if (logger.logStream) logger.logStream.end();
        console.log('✅ Logs closed');

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
process.on('uncaughtException', async (err) => {
    console.error('❌ Uncaught Exception:', err);
    await gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', async (reason) => {
    console.error('❌ Unhandled Rejection:', reason);
    await gracefulShutdown('unhandledRejection');
});

console.log('='.repeat(60));
console.log('🚀 Starting Trading Bot v4.0...');
console.log('='.repeat(60));

startServer().catch((error) => {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
});
EOF

# ============================================================
# SRC/DB/INDEX.JS
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

        this.pool.on('error', (err) => {
            console.error('[DB] Unexpected error:', err.message);
        });

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
        if (!this.isConnected) {
            throw new Error('Database not connected');
        }
        try {
            return await this.pool.query(sql, params);
        } catch (err) {
            console.error('[DB] Query error:', err.message);
            throw err;
        }
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

    getPool() {
        return this.pool;
    }

    isConnected() {
        return this.isConnected;
    }
}

module.exports = new Database();
EOF

# ============================================================
# SRC/DB/ORDER-DAO.JS
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
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
            ) ON CONFLICT (client_order_id) DO UPDATE SET
                broker_order_id = EXCLUDED.broker_order_id,
                status = EXCLUDED.status,
                broker_status = EXCLUDED.broker_status,
                updated_at = CURRENT_TIMESTAMP,
                version = orders.version + 1
            RETURNING *
        `;

        const values = [
            orderData.clientOrderId,
            orderData.brokerOrderId,
            orderData.strategyId,
            orderData.instrumentId,
            orderData.side,
            orderData.orderType || 'LIMIT',
            orderData.price,
            orderData.quantity,
            orderData.filledQuantity || 0,
            orderData.remainingQuantity || orderData.quantity,
            orderData.status || 'PENDING',
            orderData.brokerStatus,
            orderData.role,
            orderData.metadata || {},
            orderData.rawBrokerResponse,
            orderData.brokerOrderNumber,
            orderData.brokerClientCode,
            orderData.brokerExecutionId,
            orderData.brokerTransactionTime,
            orderData.isActive !== false,
            orderData.isWsConfirmed || false,
            orderData.isRestConfirmed || false,
        ];

        const result = await db.query(query, values);
        return result.rows[0];
    }

    async getOrderByClientId(clientOrderId) {
        const query = 'SELECT * FROM orders WHERE client_order_id = $1';
        const result = await db.query(query, [clientOrderId]);
        return result.rows[0] || null;
    }

    async getOrderByBrokerId(brokerOrderId) {
        const query = 'SELECT * FROM orders WHERE broker_order_id = $1';
        const result = await db.query(query, [brokerOrderId]);
        return result.rows[0] || null;
    }

    async getAllActiveOrders() {
        const query = `
            SELECT * FROM orders 
            WHERE is_active = true 
            AND status IN ('PENDING', 'ACTIVE', 'PARTIALLY_FILLED')
            ORDER BY created_at DESC
        `;
        const result = await db.query(query);
        return result.rows;
    }

    async updateOrderStatus(clientOrderId, status, brokerStatus = null, data = null) {
        const query = `
            UPDATE orders 
            SET 
                status = $1,
                broker_status = COALESCE($2, broker_status),
                updated_at = CURRENT_TIMESTAMP,
                version = version + 1,
                raw_broker_response = COALESCE($3, raw_broker_response),
                is_ws_confirmed = CASE WHEN $4 THEN true ELSE is_ws_confirmed END,
                is_rest_confirmed = CASE WHEN $5 THEN true ELSE is_rest_confirmed END,
                confirmed_at = CASE WHEN $6 THEN CURRENT_TIMESTAMP ELSE confirmed_at END,
                filled_at = CASE WHEN $7 THEN CURRENT_TIMESTAMP ELSE filled_at END,
                cancelled_at = CASE WHEN $8 THEN CURRENT_TIMESTAMP ELSE cancelled_at END,
                is_active = CASE 
                    WHEN $9 THEN false 
                    ELSE is_active 
                END
            WHERE client_order_id = $10
            RETURNING *
        `;

        const isFinal = ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'REPLACING'].includes(status);
        const isFilled = status === 'FILLED';
        const isCancelled = status === 'CANCELLED' || status === 'REJECTED' || status === 'EXPIRED';

        const values = [
            status,
            brokerStatus,
            data ? JSON.stringify(data) : null,
            true,
            true,
            status === 'ACTIVE' || status === 'CONFIRMED',
            isFilled,
            isCancelled,
            isFinal,
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
            orderId,
            status,
            brokerStatus,
            data?.price || null,
            data?.quantity || null,
            data?.filledQuantity || null,
            data?.remainingQuantity || null,
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
            logData.level,
            logData.service,
            logData.strategyId,
            logData.orderId,
            logData.message,
            logData.context ? JSON.stringify(logData.context) : null,
            logData.sourceFile,
            logData.sourceLine,
            logData.traceId
        ];

        const result = await db.query(query, values);
        return result.rows[0]?.id || null;
    }
}

module.exports = new OrderDAO();
EOF

# ============================================================
# SRC/SERVICES/AUTH.JS (из v3.0.1)
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
            req.on('error', (e) => {
                reject(new Error(`Request failed: ${e.message}`));
            });
            req.setTimeout(10000, () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
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
# SRC/SERVICES/REST-API.JS (из v3.0.1)
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
        const logPrefix = `[REST #${requestId}]`;
        logger.info(`${logPrefix} ${method} ${path}`);

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
                        try {
                            parsedBody = JSON.parse(data);
                        } catch (e) {
                            parsedBody = data;
                        }
                        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsedBody });
                    });
                });
                req.on('error', (e) => {
                    const duration = Date.now() - startTime;
                    this.updateStats(duration, false, e.message);
                    reject(e);
                });
                req.setTimeout(10000, () => {
                    req.destroy();
                    reject(new Error('Request timeout'));
                });
                if (body) {
                    const bodyStr = JSON.stringify(body);
                    req.write(bodyStr);
                }
                req.end();
            });
        } catch (e) {
            throw e;
        }
    }

    async requestWithRetry(method, path, body = null, retryCount = 0) {
        const maxRetries = config.maxRetries || 10;
        const retryDelay = config.retryDelay || 1.0;
        try {
            return await this.request(method, path, body);
        } catch (e) {
            if (retryCount >= maxRetries) throw e;
            this.stats.retries = (this.stats.retries || 0) + 1;
            const delay = retryDelay * Math.pow(2, retryCount);
            await this.sleep(delay);
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

    sleep(seconds) {
        return new Promise(resolve => setTimeout(resolve, seconds * 1000));
    }

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
# SRC/ROUTES/API.JS
# ============================================================
cat > src/routes/api.js << 'EOF'
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');

// Health check
router.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        version: '4.0.0',
        timestamp: new Date().toISOString()
    });
});

// Status
router.get('/status', (req, res) => {
    res.json({
        status: 'ok',
        version: '4.0.0',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString()
    });
});

module.exports = router;
EOF

# ============================================================
# SRC/PUBLIC/INDEX.HTML
# ============================================================
mkdir -p src/public
cat > src/public/index.html << 'EOF'
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🤖 Trading Bot v4.0</title>
</head>
<body>
    <h1>🤖 Trading Bot v4.0</h1>
    <p>PostgreSQL + Global Stack</p>
    <p>Status: <span id="status">Loading...</span></p>
    <script>
        fetch('/bot/api/status')
            .then(r => r.json())
            .then(data => {
                document.getElementById('status').textContent = '✅ Online';
                console.log('Bot status:', data);
            })
            .catch(() => {
                document.getElementById('status').textContent = '❌ Offline';
            });
    </script>
</body>
</html>
EOF

echo ""
echo "✅ ДОБАВЛЕНЫ НЕДОСТАЮЩИЕ ФАЙЛЫ!"
echo ""
echo "📁 Теперь структура проекта полная:"
find src -type f -name "*.js" | sort | sed 's/^/  /'