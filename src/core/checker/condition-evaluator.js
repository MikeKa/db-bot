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
        this._reconcileInProgress = false;

        this.on('reconcile_complete', (data) => {
            logger.info(`[Evaluator] Reconcile complete for ${data.strategyId}: ${data.stackSize} orders`);
            if (this.isRunning && this.marketData.hasValidData()) {
                const book = this.marketData.getOrderBook();
                if (book) {
                    this.checkAllStrategies(book);
                }
            }
        });
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
            if (!midPrice) {
                logger.debug(`[Evaluator] No midPrice for ${strategyId}`);
                return;
            }

            const spread = book.asks[0].price - book.bids[0].price;
            const bidPrice = strategy.calculateBidPrice(midPrice);
            if (!bidPrice || bidPrice <= 0) {
                logger.debug(`[Evaluator] Invalid bidPrice for ${strategyId}: ${bidPrice}`);
                return;
            }

            if (strategy.minPrice !== undefined && bidPrice < strategy.minPrice) {
                logger.debug(`[${strategyId}] Price ${bidPrice} below min ${strategy.minPrice}`);
                return;
            }
            if (strategy.maxPrice !== undefined && bidPrice > strategy.maxPrice) {
                logger.debug(`[${strategyId}] Price ${bidPrice} above max ${strategy.maxPrice}`);
                return;
            }

            const stack = this.orderManager?.getStack(strategyId);
            if (!stack) {
                logger.warn(`[${strategyId}] Stack not available`);
                return;
            }

            const activeOrders = stack.getValidActiveOrders();
            const pendingOrders = stack.getPendingOrders();

            const hasPendingModify = pendingOrders.some(p =>
                p.status === 'PENDING_MODIFY' || p.status === 'PENDING' || p.status === 'PENDING_CANCEL'
            );

            const params = {
                midPrice,
                bidPrice,
                spread,
                marketData: book,
                activeOrders: activeOrders,
                pendingOrders: pendingOrders,
                hasPendingModify,
                timestamp: new Date(),
                cycle: (data.lastCall || 0) + 1
            };

            const result = strategy.onData(params);
            if (!result) return;

            const intents = Array.isArray(result) ? result : [result];
            for (const intent of intents) {
                if (intent) {
                    logger.info(`[Evaluator] 📨 Received intent: ${intent.action} ${intent.symbol} @ ${intent.price}`);
                    this.emit('intent', intent);
                }
            }
            data.lastCall = Date.now();

        } catch (e) {
            logger.err(`[Evaluator] Strategy ${strategyId} error: ${e.message}`);
            this.emit('error', { strategyId, error: e });
        }
    }

    checkRateLimit(strategyId) {
        const now = Date.now();
        let counter = this._callCounts.get(strategyId);
        if (!counter) {
            counter = { count: 0, resetTime: now + 1000 };
            this._callCounts.set(strategyId, counter);
        }
        if (now > counter.resetTime) {
            counter.count = 0;
            counter.resetTime = now + 1000;
        }
        if (counter.count >= this.maxCallsPerSecond) {
            logger.debug(`[${strategyId}] Rate limit exceeded (${this.maxCallsPerSecond}/s)`);
            return false;
        }
        counter.count++;
        return true;
    }

    getStrategyInfo(strategyId) {
        const data = this.strategies.get(strategyId);
        if (!data) return null;
        return {
            id: strategyId,
            lastCall: data.lastCall ? new Date(data.lastCall).toISOString() : null,
            isActive: this.isRunning,
            rateLimit: this._callCounts.get(strategyId) || { count: 0 }
        };
    }

    getAllStrategies() {
        const result = [];
        for (const [id, data] of this.strategies) {
            result.push({
                id,
                info: data.strategy.getInfo ? data.strategy.getInfo() : { type: data.strategy.constructor.name },
                lastCall: data.lastCall ? new Date(data.lastCall).toISOString() : null
            });
        }
        return result;
    }

    getMarketData() {
        return this.marketData.getOrderBook();
    }

    getStats() {
        return {
            isRunning: this.isRunning,
            strategiesCount: this.strategies.size,
            callCounts: Array.from(this._callCounts.entries()).map(([id, counter]) => ({
                strategyId: id,
                count: counter.count,
                resetTime: new Date(counter.resetTime).toISOString()
            })),
        };
    }
}

module.exports = ConditionEvaluator;