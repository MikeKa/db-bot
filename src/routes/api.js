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

const WebSocket = require('ws');

// ============================================================
// WEBSOCKET ДЛЯ ОРДЕРБУКА
// ============================================================
const wss = new WebSocket.Server({ noServer: true });
const wsClients = new Set();

wss.on('connection', (ws) => {
    wsClients.add(ws);
    logger.info('[WS] Client connected for orderbook');

    const book = marketData.getOrderBook();
    if (book) {
        try {
            ws.send(JSON.stringify({
                type: 'orderbook',
                book: {
                    bids: book.bids || [],
                    asks: book.asks || [],
                    spread: book.spread || null,
                    updateFrequency: marketData.updateFrequency || 0
                }
            }));
        } catch (e) { }
    }

    ws.on('close', () => {
        wsClients.delete(ws);
        logger.info('[WS] Client disconnected');
    });

    ws.on('error', (error) => {
        logger.err(`[WS] Error: ${error.message}`);
    });
});

marketData.on('orderbook', (book) => {
    const data = JSON.stringify({
        type: 'orderbook',
        book: {
            bids: book.bids || [],
            asks: book.asks || [],
            spread: book.spread || null,
            updateFrequency: marketData.updateFrequency || 0
        }
    });

    for (const client of wsClients) {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(data); } catch (e) { }
        }
    }
});

// ============================================================
// WEBSOCKET ДЛЯ ТРАНЗАКЦИЙ
// ============================================================
const wssTransactions = new WebSocket.Server({ noServer: true });
const wsTxClients = new Set();

wssTransactions.on('connection', (ws) => {
    wsTxClients.add(ws);
    logger.info('[WS TX] Client connected');

    ws.on('close', () => {
        wsTxClients.delete(ws);
        logger.info('[WS TX] Client disconnected');
    });

    ws.on('error', (error) => {
        logger.err(`[WS TX] Error: ${error.message}`);
    });
});

function broadcastTransaction(eventType, data) {
    const message = JSON.stringify({
        type: 'transaction',
        event: eventType,
        payload: data
    });

    for (const client of wsTxClients) {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(message); } catch (e) { }
        }
    }
}

transactionsWs.on('orderCreated', (data) => broadcastTransaction('orderCreated', data));
transactionsWs.on('orderModified', (data) => broadcastTransaction('orderModified', data));
transactionsWs.on('orderFilled', (data) => broadcastTransaction('orderFilled', data));
transactionsWs.on('orderCancelled', (data) => broadcastTransaction('orderCancelled', data));
transactionsWs.on('orderError', (data) => broadcastTransaction('orderError', data));
transactionsWs.on('orderUpdate', (data) => broadcastTransaction('orderUpdate', data));

// ============================================================
// WEBSOCKET ДЛЯ ОБНОВЛЕНИЙ СТЕКА
// ============================================================
const wssStackUpdates = new WebSocket.Server({ noServer: true });
const wsStackClients = new Set();

wssStackUpdates.on('connection', (ws) => {
    wsStackClients.add(ws);
    logger.info('[WS STACK] Client connected');

    ws.on('close', () => {
        wsStackClients.delete(ws);
        logger.info('[WS STACK] Client disconnected');
    });

    ws.on('error', (error) => {
        logger.err(`[WS STACK] Error: ${error.message}`);
    });
});

function broadcastStackUpdate(data) {
    const message = JSON.stringify({
        type: 'stack_update',
        payload: data
    });

    for (const client of wsStackClients) {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(message); } catch (e) { }
        }
    }
}

const om = initializer.components?.orderManager;
if (om) {
    om.on('stack_updated', (data) => {
        broadcastStackUpdate(data);
    });
    om.on('sync_status_changed', (data) => {
        broadcastStackUpdate(data);
    });
    om.on('ws_disconnected', (data) => {
        broadcastStackUpdate({ type: 'ws_disconnected', payload: data });
    });
    om.on('ws_reconnected', (data) => {
        broadcastStackUpdate({ type: 'ws_reconnected', payload: data });
    });
    om.on('emergency_stop_triggered', (data) => {
        broadcastStackUpdate({ type: 'emergency_stop', payload: data });
    });
}

// ============================================================
// API ROUTES
// ============================================================
router.get('/status', (req, res) => {
    try {
        const status = initializer.getStatus ? initializer.getStatus() : {};

        const stacks = {};
        let totalActive = 0;
        let totalPending = 0;
        let totalHistory = 0;

        const om = initializer.components?.orderManager;
        if (om) {
            const stats = om.getStats();
            if (stats && stats.stacks) {
                Object.keys(stats.stacks).forEach(key => {
                    stacks[key] = stats.stacks[key];
                    totalActive += stats.stacks[key].activeCount || 0;
                    totalPending += stats.stacks[key].pendingCount || 0;
                    totalHistory += stats.stacks[key].historyCount || 0;
                });
            }
        }

        const book = marketData.getOrderBook();
        const midPrice = marketData.getMidPrice();

        let activeOrders = [];
        if (om) {
            activeOrders = om.getActiveOrders().map(o => ({
                clientOrderId: o.clientOrderId,
                brokerOrderId: o.brokerOrderId,
                price: o.price,
                quantity: o.quantity,
                status: o.status,
                side: o.side || 'BUY',
                role: o.role || null,
                strategyId: o.strategyId,
                createdAt: o.createdAt || new Date().toISOString()
            }));
        }

        let orderHistory = [];
        if (om) {
            const history = om.getHistory(null, 50);
            orderHistory = history.map(o => ({
                clientOrderId: o.clientOrderId,
                price: o.price,
                quantity: o.quantity,
                status: o.status,
                side: o.side || 'BUY',
                createdAt: o.createdAt || o.archivedAt || new Date().toISOString()
            }));
        }

        // Получаем статус синхронизации
        const syncStatus = om ? om.getSyncStatus() : {};

        res.json({
            success: true,
            isRunning: status.isRunning || false,
            isHealthy: initializer.isHealthy ? initializer.isHealthy() : false,
            uptime: process.uptime(),
            orderManager: {
                stacks: stacks,
                totalActive: totalActive,
                totalPending: totalPending,
                totalHistory: totalHistory,
            },
            marketData: {
                isConnected: marketData.isConnected || false,
                isSubscribed: marketData.isSubscribed || false,
                hasData: marketData.hasValidData ? marketData.hasValidData() : false,
                orderBook: book ? {
                    bids: book.bids || [],
                    asks: book.asks || [],
                    spread: book.spread || null,
                } : null,
                midPrice: midPrice,
                updateFrequency: marketData.updateFrequency || 0,
            },
            transactionsWs: {
                isConnected: transactionsWs.isConnected || false,
                messageCount: transactionsWs.messageCount || 0,
            },
            auth: {
                hasToken: !!auth.accessToken,
                isTokenValid: auth.isTokenValid ? auth.isTokenValid() : false,
                expiresIn: auth.getTimeUntilExpiry ? auth.getTimeUntilExpiry() : 0,
                expiresInHours: auth.getTimeUntilExpiry ? (auth.getTimeUntilExpiry() / 3600).toFixed(1) : '?',
            },
            riskManager: {
                state: initializer.components?.riskManager?.getState() || {},
            },
            executionQueue: {
                queueSizes: initializer.components?.executionQueue?.getStats()?.queueSizes || { TOTAL: 0 },
            },
            syncStatus: syncStatus,
            activeOrders: activeOrders,
            orderHistory: orderHistory,
            timestamp: new Date().toISOString()
        });
    } catch (e) {
        logger.err(`[API] /status error: ${e.message}`);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/strategies', (req, res) => {
    try {
        const strategies = strategyRegistry.getInfo();
        res.json({
            success: true,
            count: strategies.length,
            strategies: strategies.map(s => ({
                ...s,
                isActive: s.info?.state?.isActive || false,
            }))
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/strategies/:id', (req, res) => {
    try {
        const strategy = strategyRegistry.get(req.params.id);
        if (!strategy) {
            return res.status(404).json({ success: false, error: 'Strategy not found' });
        }
        res.json({
            success: true,
            strategy: strategy.getInfo()
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/strategies/:id/orders', (req, res) => {
    try {
        const { id } = req.params;

        const om = initializer.components?.orderManager;
        if (!om) {
            return res.status(500).json({
                success: false,
                error: 'OrderManager not initialized'
            });
        }

        const stack = om.getStack(id);
        if (!stack) {
            return res.status(404).json({
                success: false,
                error: 'Stack not found for strategy'
            });
        }

        const activeOrders = stack.getActiveOrders();

        const orders = activeOrders.map(o => ({
            client_order_id: o.clientOrderId,
            broker_order_id: o.brokerOrderId,
            price: o.price,
            quantity: o.quantity,
            filled_quantity: o.filledQuantity || 0,
            remaining_quantity: o.remainingQuantity || o.quantity,
            status: o.status,
            side: o.side || 'BUY',
            role: o.role || null,
            created_at: o.createdAt || new Date().toISOString(),
            updated_at: o.updatedAt || new Date().toISOString(),
        }));

        res.json({
            success: true,
            count: orders.length,
            orders: orders
        });
    } catch (e) {
        logger.err(`[API] Error getting orders: ${e.message}`);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/strategies/:id/history', (req, res) => {
    try {
        const { id } = req.params;
        const limit = parseInt(req.query.limit) || 50;

        const om = initializer.components?.orderManager;
        if (!om) {
            return res.status(500).json({
                success: false,
                error: 'OrderManager not initialized'
            });
        }

        const stack = om.getStack(id);
        if (!stack) {
            return res.status(404).json({
                success: false,
                error: 'Stack not found for strategy'
            });
        }

        const history = stack.getHistory(limit);

        res.json({
            success: true,
            count: history.length,
            orders: history.map(o => ({
                client_order_id: o.clientOrderId,
                broker_order_id: o.brokerOrderId,
                price: o.price,
                quantity: o.quantity,
                status: o.status,
                side: o.side || 'BUY',
                role: o.role || null,
                created_at: o.createdAt || o.archivedAt || new Date().toISOString(),
            }))
        });
    } catch (e) {
        logger.err(`[API] Error getting history: ${e.message}`);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/strategies/:id/stats', async (req, res) => {
    try {
        const stats = await orderDAO.getStrategyStats(req.params.id);
        res.json({
            success: true,
            stats: stats || {
                total_orders: 0,
                filled_orders: 0,
                cancelled_orders: 0,
                error_orders: 0,
                active_orders: 0,
                total_filled_quantity: 0,
                avg_price: 0
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

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

router.post('/cancel', (req, res) => {
    try {
        const om = initializer.components?.orderManager;
        if (!om) {
            return res.status(500).json({ success: false, error: 'OrderManager not initialized' });
        }

        const stacks = om.stacks || new Map();
        const results = [];
        for (const [strategyId, stack] of stacks) {
            for (const order of stack.getActiveOrders()) {
                const result = om.cancelOrder(order.clientOrderId, stack);
                results.push(result);
            }
        }
        res.json({ success: true, message: `Cancelled ${results.length} orders`, results });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/strategies/:id/start', (req, res) => {
    try {
        const strategy = strategyRegistry.get(req.params.id);
        if (!strategy) {
            return res.status(404).json({ success: false, error: 'Strategy not found' });
        }
        if (strategy.start) strategy.start();
        res.json({ success: true, message: `Strategy ${req.params.id} started` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/strategies/:id/stop', (req, res) => {
    try {
        const strategy = strategyRegistry.get(req.params.id);
        if (!strategy) {
            return res.status(404).json({ success: false, error: 'Strategy not found' });
        }
        if (strategy.stop) strategy.stop();
        res.json({ success: true, message: `Strategy ${req.params.id} stopped` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/orderbook', (req, res) => {
    try {
        const book = marketData.getOrderBook();
        const midPrice = marketData.getMidPrice();

        if (book) {
            res.json({
                success: true,
                orderbook: {
                    ticker: book.ticker || 'SBER',
                    classCode: book.classCode || 'TQBR',
                    bids: book.bids ? book.bids.slice(0, 10) : [],
                    asks: book.asks ? book.asks.slice(0, 10) : [],
                    spread: book.spread,
                    midPrice: midPrice,
                    timestamp: new Date().toISOString()
                }
            });
        } else {
            res.json({
                success: false,
                error: 'No orderbook data available',
                isConnected: marketData.isConnected || false,
                isSubscribed: marketData.isSubscribed || false
            });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/orders/active', (req, res) => {
    try {
        const om = initializer.components?.orderManager;
        if (!om) {
            return res.status(500).json({
                success: false,
                error: 'OrderManager not initialized'
            });
        }

        const activeOrders = om.getActiveOrders();

        res.json({
            success: true,
            count: activeOrders.length,
            orders: activeOrders.map(o => ({
                client_order_id: o.clientOrderId,
                broker_order_id: o.brokerOrderId,
                strategy_id: o.strategyId,
                price: o.price,
                quantity: o.quantity,
                status: o.status,
                side: o.side || 'BUY',
                role: o.role || null,
                created_at: o.createdAt || new Date().toISOString(),
            }))
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
        market: marketData.isConnected ? 'connected' : 'disconnected',
        transactions: transactionsWs.isConnected ? 'connected' : 'disconnected',
        auth: auth.isTokenValid ? 'valid' : 'invalid',
        timestamp: new Date().toISOString()
    });
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

router.get('/risk/status', (req, res) => {
    try {
        const comps = initializer.components || {};
        const riskManager = comps.riskManager;
        if (!riskManager) {
            return res.status(500).json({ success: false, error: 'RiskManager not initialized' });
        }
        res.json({ success: true, state: riskManager.getState(), config: riskManager.getConfig() });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/risk/reset-circuit-breaker', (req, res) => {
    try {
        const comps = initializer.components || {};
        const riskManager = comps.riskManager;
        if (!riskManager) {
            return res.status(500).json({ success: false, error: 'RiskManager not initialized' });
        }
        riskManager.resetCircuitBreaker();
        res.json({ success: true, message: 'Circuit breaker reset' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// СТАТУС СИНХРОНИЗАЦИИ
// ============================================================
router.get('/sync/status', (req, res) => {
    try {
        const om = initializer.components?.orderManager;
        if (!om) {
            return res.status(500).json({ success: false, error: 'OrderManager not initialized' });
        }

        const strategies = strategyRegistry.getAll();
        const syncStatus = {};

        for (const strategy of strategies) {
            const stack = om.getStack(strategy.id);
            if (stack) {
                syncStatus[strategy.id] = stack.getSyncStatus();
            }
        }

        res.json({
            success: true,
            syncStatus: syncStatus,
            timestamp: new Date().toISOString()
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// ПРИНУДИТЕЛЬНЫЙ REST SYNC
// ============================================================
router.post('/sync/rest', async (req, res) => {
    try {
        const om = initializer.components?.orderManager;
        if (!om) {
            return res.status(500).json({ success: false, error: 'OrderManager not initialized' });
        }

        const strategyId = req.body.strategyId || 'sber_bid';
        const stack = om.getStack(strategyId);
        if (!stack) {
            return res.status(404).json({ success: false, error: 'Stack not found' });
        }

        await stack.syncWithRestFallback(om.brokerAdapter);

        res.json({
            success: true,
            message: 'REST sync completed',
            syncStatus: stack.getSyncStatus()
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
module.exports.wss = wss;
module.exports.wssTransactions = wssTransactions;
module.exports.wssStackUpdates = wssStackUpdates;