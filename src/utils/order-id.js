const crypto = require('crypto');

class OrderIdGenerator {
    static generate(strategyId, instrument, side, role, timestamp = Date.now()) {
        const uuid = crypto.randomUUID().slice(0, 8);
        return `${strategyId}_${instrument}_${side}_${role}_${timestamp}_${uuid}`;
    }

    static parse(clientOrderId) {
        if (!clientOrderId) return null;
        const parts = clientOrderId.split('_');
        if (parts.length < 6) return null;
        return {
            strategyId: parts[0],
            instrument: parts[1],
            side: parts[2],
            role: parts[3],
            timestamp: parseInt(parts[4]),
            uuid: parts[5],
            fullId: clientOrderId
        };
    }

    static isStructured(clientOrderId) {
        return this.parse(clientOrderId) !== null;
    }

    static getStrategyId(clientOrderId) {
        const parsed = this.parse(clientOrderId);
        return parsed ? parsed.strategyId : null;
    }
}

module.exports = OrderIdGenerator;
