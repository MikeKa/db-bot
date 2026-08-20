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
        if (this._resetTimer) clearInterval(this._resetTimer);
        this._resetTimer = setInterval(() => this.checkDailyReset(), 3600000);
        logger.info('[Risk] Risk Manager started');
    }

    stop() {
        if (this._resetTimer) {
            clearInterval(this._resetTimer);
            this._resetTimer = null;
        }
    }

    validate(request) {
        const result = { approved: false, reason: null, metadata: {} };
        try {
            if (this.state.isCircuitBreakerOpen) {
                return this.reject(result, 'Circuit breaker is open');
            }
            if (this.state.dailyLoss < this.config.dailyLossLimit) {
                this.tripCircuitBreaker(`Daily loss limit exceeded: ${this.state.dailyLoss}`);
                return this.reject(result, 'Daily loss limit exceeded');
            }
            if (this.state.dailyOrders >= this.config.maxDailyOrders) {
                return this.reject(result, `Daily order limit exceeded`);
            }
            if (request.price <= 0) {
                return this.reject(result, 'Invalid price');
            }
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

    // ============================================================
    // ДОБАВЛЯЕМ МЕТОД onExecutionReport
    // ============================================================
    onExecutionReport(report) {
        if (!report) return;

        logger.debug(`[Risk] Processing execution report: ${report.status}`);

        if (report.status === 'FILLED' || report.status === 'PARTIALLY_FILLED') {
            const sideMultiplier = report.side === 'BUY' ? -1 : 1;
            const pnl = (report.filledPrice || report.price) * (report.filledQuantity || report.quantity) * sideMultiplier;
            this.state.dailyPnl += pnl;
            this.state.dailyLoss += pnl;
            const posChange = (report.filledQuantity || report.quantity) * (report.side === 'BUY' ? 1 : -1);
            this.state.totalPosition += posChange;

            logger.debug(`[Risk] PnL: ${pnl}, Position: ${this.state.totalPosition}, Daily Loss: ${this.state.dailyLoss}`);
        }

        if (report.status === 'ERROR' || report.status === 'REJECTED') {
            this.state.errors++;
            this.state.lastErrorAt = new Date();
            if (this.state.errors >= this.config.maxConsecutiveErrors) {
                this.tripCircuitBreaker(`Too many errors: ${this.state.errors}`);
            }
        } else {
            this.state.errors = 0;
        }

        this.emit('report_processed', { report, state: this.state });
    }

    reject(result, reason) {
        result.approved = false;
        result.reason = reason;
        this.emit('request_rejected', { reason, state: this.state });
        return result;
    }

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

    getState() {
        return {
            ...this.state,
            uptime: (Date.now() - this.state.startTime.getTime()) / 1000
        };
    }

    getConfig() {
        return { ...this.config };
    }

    getStats() {
        return {
            state: this.getState(),
            config: this.getConfig()
        };
    }

    forceDailyReset() {
        this._lastResetDate = new Date().toDateString();
        this.state.dailyPnl = 0;
        this.state.dailyOrders = 0;
        this.state.dailyLoss = 0;
        this.state.errors = 0;
        this.state.orderWindow = [];
        logger.info('[Risk] Forced daily reset');
        this.emit('daily_reset');
    }
}

module.exports = RiskManager;