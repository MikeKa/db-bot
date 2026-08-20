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
