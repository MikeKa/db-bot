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
