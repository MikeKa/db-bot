const strategyConfig = require('../config/strategy');

class PriceCalculator {
    static calculateOrderPrice(midPrice, offsetPercent = strategyConfig.priceOffsetPercent) {
        if (!midPrice || midPrice <= 0) throw new Error('Invalid midPrice');
        const price = midPrice * (1 - offsetPercent / 100);
        return Math.round(price * 100) / 100;
    }

    static calculateModifyPrice(midPrice) {
        return this.calculateOrderPrice(midPrice, strategyConfig.modifyOffsetPercent);
    }

    static shouldModify(currentPrice, newPrice, threshold = strategyConfig.modifyThreshold) {
        if (strategyConfig.forceModify) return true;
        if (!currentPrice || !newPrice) return false;
        return Math.abs(currentPrice - newPrice) >= threshold;
    }

    static getMidPrice(orderBook) {
        if (!orderBook || !orderBook.bids || !orderBook.asks ||
            !orderBook.bids.length || !orderBook.asks.length) return null;
        return (orderBook.bids[0].price + orderBook.asks[0].price) / 2;
    }

    static calculateSpread(orderBook) {
        if (!orderBook || !orderBook.bids || !orderBook.asks ||
            !orderBook.bids.length || !orderBook.asks.length) return null;
        return orderBook.asks[0].price - orderBook.bids[0].price;
    }
}

module.exports = PriceCalculator;
