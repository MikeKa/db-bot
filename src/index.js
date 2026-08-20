// Точка входа v4.0
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

// Health check
app.get(`${basePath}/health`, (req, res) => {
    const status = initializer.getStatus ? initializer.getStatus() : {};
    res.json({
        status: 'ok',
        version: '4.0.0',
        initialized: initializer.initialized || false,
        isHealthy: initializer.isHealthy ? initializer.isHealthy() : false,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        pid: process.pid,
        memory: process.memoryUsage(),
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
    // Подключаемся к БД
    try {
        await db.connect();
        logger.ok('✅ Database connected');
    } catch (error) {
        logger.err(`❌ Database connection failed: ${error.message}`);
        logger.warn('⚠️ Bot will start without database');
    }

    // Инициализируем компоненты
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
        console.log(`📊 Logging: ${logger.getLevelName()} (${logger.getStatus().disabled ? 'DISABLED' : 'ENABLED'})`);
        console.log('='.repeat(60));
        console.log('Press Ctrl+C to stop');
        console.log('='.repeat(60));
    });

    // ============================================================
    // WEBSOCKET ДЛЯ ВСЕХ ТРЕХ КАНАЛОВ
    // ============================================================
    const { wss, wssTransactions, wssStackUpdates } = require('./routes/api');

    if (wss && wssTransactions && wssStackUpdates) {
        server.on('upgrade', (request, socket, head) => {
            const pathname = request.url;

            if (pathname === basePath + '/api/ws/orderbook' || pathname === '/bot/api/ws/orderbook') {
                wss.handleUpgrade(request, socket, head, (ws) => {
                    wss.emit('connection', ws, request);
                });
            }
            else if (pathname === basePath + '/api/ws/transactions' || pathname === '/bot/api/ws/transactions') {
                wssTransactions.handleUpgrade(request, socket, head, (ws) => {
                    wssTransactions.emit('connection', ws, request);
                });
            }
            else if (pathname === basePath + '/api/ws/stack-updates' || pathname === '/bot/api/ws/stack-updates') {
                wssStackUpdates.handleUpgrade(request, socket, head, (ws) => {
                    wssStackUpdates.emit('connection', ws, request);
                });
            }
            else {
                socket.destroy();
            }
        });

        logger.info('✅ All WebSocket servers ready');
        logger.info(`📡 OrderBook WS: ws://localhost:${port}${basePath}/api/ws/orderbook`);
        logger.info(`📡 Transactions WS: ws://localhost:${port}${basePath}/api/ws/transactions`);
        logger.info(`📡 Stack Updates WS: ws://localhost:${port}${basePath}/api/ws/stack-updates`);
    } else {
        logger.warn('⚠️ WebSocket servers not available');
    }
}

async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n🛑 Received ${signal}, starting graceful shutdown...`);

    // Уменьшаем таймаут до 5 секунд
    const forceExitTimeout = setTimeout(() => {
        console.error('❌ Shutdown timeout (5s), forcing exit...');
        process.exit(1);
    }, 5000);

    try {
        console.log('⏹️ Stopping bot...');
        initializer.stopBot();

        // Закрываем WebSocket серверы
        console.log('🔌 Closing WebSocket servers...');
        const { wss, wssTransactions, wssStackUpdates } = require('./routes/api');

        const closeWebSocket = (wsServer, name) => {
            return new Promise((resolve) => {
                if (!wsServer) {
                    resolve();
                    return;
                }
                // Закрываем все клиентские соединения
                wsServer.clients.forEach((client) => {
                    if (client.readyState === 1) { // WebSocket.OPEN
                        client.close(1000, 'Server shutting down');
                    }
                });
                // Закрываем сервер
                wsServer.close(() => {
                    console.log(`✅ ${name} closed`);
                    resolve();
                });
            });
        };

        await Promise.all([
            closeWebSocket(wss, 'OrderBook WS'),
            closeWebSocket(wssTransactions, 'Transactions WS'),
            closeWebSocket(wssStackUpdates, 'Stack Updates WS')
        ]);

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
        if (logger.logStream) {
            try {
                logger.logStream.end();
            } catch (e) {
                // Игнорируем ошибки при закрытии логов
            }
        }
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
    // При необработанном исключении - немедленный выход
    process.exit(1);
});
process.on('unhandledRejection', async (reason) => {
    console.error('❌ Unhandled Rejection:', reason);
    // При необработанном отклонении - немедленный выход
    process.exit(1);
});

console.log('='.repeat(60));
console.log('🚀 Starting Trading Bot v4.0...');
console.log('='.repeat(60));

startServer().catch((error) => {
    console.error('❌ Failed to start server:', error.message);
    console.error(error.stack);
    process.exit(1);
});