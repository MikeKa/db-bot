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
