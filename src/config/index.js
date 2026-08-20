const dotenv = require('dotenv');
dotenv.config();

module.exports = {
    port: parseInt(process.env.PORT) || 3001,
    basePath: process.env.BASE_PATH || '/bot',
    refreshToken: process.env.BCS_REFRESH_TOKEN,
    baseUrl: process.env.BASE_URL || 'https://be.broker.ru',
    wsTransactionsUrl: process.env.WS_TRANSACTIONS_URL ||
        'wss://ws.broker.ru/trade-api-bff-operations/api/v1/orders/events/ws',
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
