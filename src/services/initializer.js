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
            await this.ensureStrategyInDb();
            return true;
        } catch (error) {
            logger.err(`❌ Database connection failed: ${error.message}`);
            return false;
        }
    }

    async ensureStrategyInDb() {
        try {
            const result = await db.query('SELECT id FROM strategies WHERE id = $1', ['sber_bid']);
            if (result.rows.length === 0) {
                await db.query(`
                    INSERT INTO strategies (id, name, type, symbol, class_code, config, status)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                `, [
                    'sber_bid',
                    'SBER BID Strategy',
                    'constant-bid',
                    'SBER',
                    'TQBR',
                    JSON.stringify({ offsetPercent: 1, quantity: 1 }),
                    'INACTIVE'
                ]);
                logger.ok('✅ Strategy created in database: sber_bid');
            } else {
                logger.debug('✅ Strategy already exists in database: sber_bid');
            }
        } catch (error) {
            logger.warn(`⚠️ Failed to ensure strategy in DB: ${error.message}`);
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
            await this.waitForMarketData();
            return true;
        } catch (error) {
            logger.err(`❌ Market WS failed: ${error.message}`);
            return false;
        }
    }

    async waitForMarketData() {
        let attempts = 0;
        while (attempts < 30) {
            if (marketData.hasValidData()) {
                logger.ok('✅ Market data received');
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 200));
            attempts++;
        }
        logger.warn('⚠️ No market data received after 6 seconds');
        return false;
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
                idempotencyTTL: 60000,
                useDb: true
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

            // Обработка намерений от стратегий
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

            // ============================================================
            // ПОДКЛЮЧАЕМ ТРАНЗАКЦИИ - СИНХРОНИЗАЦИЯ В РЕАЛЬНОМ ВРЕМЕНИ
            // ============================================================
            transactionsWs.on('orderCreated', (data) => {
                const event = this.parseWsEvent(data, 'CREATED');
                if (event) {
                    logger.info(`[WS TX] 📨 Order CREATED: ${event.clientOrderId}`);
                    orderManager.syncWithWs(event);
                }
            });

            transactionsWs.on('orderModified', (data) => {
                const event = this.parseWsEvent(data, 'MODIFIED');
                if (event) {
                    logger.info(`[WS TX] 📨 Order MODIFIED: ${event.clientOrderId}`);
                    orderManager.syncWithWs(event);
                }
            });

            transactionsWs.on('orderFilled', (data) => {
                const event = this.parseWsEvent(data, 'PARTIALLY_FILLED');
                if (event) {
                    logger.info(`[WS TX] 📨 Order FILLED: ${event.clientOrderId} (${event.filledQuantity})`);
                    orderManager.syncWithWs(event);
                }
            });

            transactionsWs.on('orderCancelled', (data) => {
                const event = this.parseWsEvent(data, 'CANCELLED');
                if (event) {
                    logger.info(`[WS TX] 📨 Order CANCELLED: ${event.clientOrderId}`);
                    orderManager.syncWithWs(event);
                }
            });

            transactionsWs.on('orderError', (data) => {
                const event = this.parseWsEvent(data, 'ERROR');
                if (event) {
                    logger.err(`[WS TX] ❌ Order ERROR: ${event.clientOrderId}`);
                    orderManager.syncWithWs(event);
                }
            });

            transactionsWs.on('orderUpdate', (data) => {
                const event = this.parseWsEvent(data, 'UPDATE');
                if (event) {
                    logger.debug(`[WS TX] 📨 Order UPDATE: ${event.clientOrderId} (${event.status})`);
                    orderManager.syncWithWs(event);
                }
            });

            executionEngine.on('execution_complete', (result) => {
                if (result.success && this.components.riskManager) {
                    try {
                        if (typeof this.components.riskManager.onExecutionReport === 'function') {
                            this.components.riskManager.onExecutionReport({
                                status: result.status === 'CONFIRMED' ? 'FILLED' : 'ERROR',
                                filledQuantity: result.data?.quantity || 0,
                                filledPrice: result.data?.price || 0,
                                side: 'BUY',
                                price: result.data?.price || 0,
                                quantity: result.data?.quantity || 0,
                            });
                        }
                    } catch (e) {
                        logger.warn(`[Engine] Risk report error: ${e.message}`);
                    }
                }
            });

            orderManager.setRiskManager(riskManager);
            orderManager.setExecutionQueue(executionQueue);

            this.state.core = true;
            logger.ok('✅ Core components initialized');
            return true;
        } catch (error) {
            logger.err(`❌ Core initialization failed: ${error.message}`);
            return false;
        }
    }

    parseWsEvent(data, defaultStatus) {
        const clientOrderId = data.clientOrderId || data.originalClientOrderId || null;
        if (!clientOrderId) return null;

        let strategyId = 'sber_bid';
        if (clientOrderId.includes('_')) {
            const parts = clientOrderId.split('_');
            if (parts.length > 0 && this.components.orderManager) {
                const stacks = this.components.orderManager.stacks || new Map();
                for (const [id, stack] of stacks) {
                    if (clientOrderId.startsWith(id + '_')) {
                        strategyId = id;
                        break;
                    }
                }
            }
        }

        return {
            strategyId: strategyId,
            clientOrderId: clientOrderId,
            orderId: data.orderId || data.data?.orderId || null,
            status: data.status || data.data?.orderStatus || defaultStatus,
            price: data.price || data.data?.price || 0,
            quantity: data.quantity || data.data?.orderQuantity || 0,
            filledQuantity: data.filledQuantity || data.data?.executedQuantity || 0,
            remainingQuantity: data.remainingQuantity || data.data?.remainedQuantity || 0,
            raw: data,
            originalClientOrderId: data.originalClientOrderId || null
        };
    }

    async initializeStrategies() {
        logger.info('📈 Step 6/6: Initializing strategies...');

        try {
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
                if (book.bids.length === 0 || book.asks.length === 0) return false;
                return true;
            };

            this.components.conditionEvaluator.registerStrategy(sberStrategy, sberCondition);
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

        if (!marketData.hasValidData()) {
            logger.warn('⚠️ No market data available, waiting...');
            marketData.forceReconnect();
        }

        // Запускаем стратегии
        const strategies = strategyRegistry.getAll();
        for (const strategy of strategies) {
            if (strategy.start) {
                strategy.start();
                logger.ok(`[Initializer] Strategy ${strategy.id} started`);
            }
        }

        evaluator.start();
        engine.start();

        logger.ok('✅ Bot started!');
        logger.info('📊 Monitoring market data...');
        return true;
    }

    stopBot() {
        logger.info('[Initializer] 🔄 Stopping bot...');

        const evaluator = this.components.conditionEvaluator;
        const engine = this.components.executionEngine;
        const strategies = strategyRegistry.getAll();

        for (const strategy of strategies) {
            if (strategy.stop) {
                strategy.stop();
                logger.info(`[Initializer] Strategy ${strategy.id} stopped`);
            }
        }

        if (evaluator && evaluator.isRunning) {
            evaluator.stop();
            logger.info('[Initializer] Evaluator stopped');
        }

        if (engine && engine.executionQueue) {
            engine.executionQueue.clear();
            logger.info('[Initializer] Execution queue cleared');
        }

        logger.info('⏹️ Bot stopped');
        return true;
    }

    getStatus() {
        const evaluator = this.components.conditionEvaluator;
        const allStrategies = strategyRegistry.getAll();
        const activeStrategies = allStrategies.filter(s => s.isActive);

        const book = marketData.getOrderBook();
        const midPrice = book ? (book.bids[0]?.price + book.asks[0]?.price) / 2 : null;

        // Получаем статус синхронизации
        const syncStatus = this.components.orderManager?.getSyncStatus() || {};

        return {
            initialized: this.initialized,
            state: this.state,
            isRunning: evaluator ? evaluator.isRunning : false,
            emergencyStop: this._lastEmergencyStop ? {
                reason: this._lastEmergencyStop.reason,
                timestamp: new Date().toISOString()
            } : null,
            marketData: {
                hasData: marketData.hasValidData(),
                midPrice: midPrice,
                bids: book ? book.bids?.slice(0, 5) : [],
                asks: book ? book.asks?.slice(0, 5) : [],
                spread: book ? book.spread : null,
                lastUpdate: marketData.lastUpdateTime
            },
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
            syncStatus: syncStatus,
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