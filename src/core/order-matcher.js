const EventEmitter = require('events');
const logger = require('../utils/logger');

class OrderMatcher extends EventEmitter {
    constructor(globalStack, strategies = new Map()) {
        super();
        this.globalStack = globalStack;
        this.strategies = strategies;
        this.unmatchedOrders = [];
        this.orphanStrategies = new Map();
        this.stats = {
            totalMatched: 0, totalUnmatched: 0, totalOrphan: 0,
            byMethod: { byId: 0, byPrice: 0, bySide: 0, byInstrument: 0, orphan: 0 }
        };
    }

    setStrategies(strategies) {
        this.strategies = strategies;
    }

    async matchOrders(brokerOrders) {
        const results = { matched: [], unmatched: [], orphan: [], errors: [] };
        logger.info(`[Matcher] Matching ${brokerOrders.length} orders`);

        for (const brokerOrder of brokerOrders) {
            try {
                const result = this.matchSingleOrder(brokerOrder);
                if (result.matched) {
                    await this.globalStack.addOrder(result.order);
                    results.matched.push(result.order);
                    this.stats.totalMatched++;
                } else {
                    results.unmatched.push(brokerOrder);
                    this.stats.totalUnmatched++;
                }
            } catch (error) {
                logger.err(`[Matcher] Error matching order ${brokerOrder.clientOrderId}: ${error.message}`);
                results.errors.push({ order: brokerOrder, error: error.message });
            }
        }

        if (results.unmatched.length > 0) {
            const orphanResults = await this.handleUnmatchedOrders(results.unmatched);
            results.orphan = orphanResults;
            this.stats.totalOrphan += orphanResults.length;
        }

        logger.info(`[Matcher] Results: ${results.matched.length} matched, ${results.unmatched.length} unmatched, ${results.orphan.length} orphan`);
        this.emit('match_completed', results);
        return results;
    }

    matchSingleOrder(brokerOrder) {
        const { clientOrderId } = brokerOrder;
        const metadata = this.globalStack.parseOrderId(clientOrderId);

        if (metadata && this.strategies.has(metadata.strategyId)) {
            const strategy = this.strategies.get(metadata.strategyId);
            brokerOrder.strategyId = metadata.strategyId;
            brokerOrder.role = metadata.role;
            brokerOrder.matched = true;
            brokerOrder.matchMethod = 'byId';
            this.stats.byMethod.byId++;
            logger.info(`[Matcher] ✅ Order ${clientOrderId} matched to strategy ${metadata.strategyId} by ID`);
            return { matched: true, order: brokerOrder };
        }

        const priceMatch = this.matchByInstrumentAndPrice(brokerOrder);
        if (priceMatch) {
            brokerOrder.strategyId = priceMatch.id;
            brokerOrder.role = this.determineRole(brokerOrder, priceMatch);
            brokerOrder.matched = true;
            brokerOrder.matchMethod = 'byPrice';
            this.stats.byMethod.byPrice++;
            logger.info(`[Matcher] ✅ Order ${clientOrderId} matched to strategy ${priceMatch.id} by price`);
            return { matched: true, order: brokerOrder };
        }

        const sideMatch = this.matchByInstrumentAndSide(brokerOrder);
        if (sideMatch) {
            brokerOrder.strategyId = sideMatch.id;
            brokerOrder.role = this.determineRole(brokerOrder, sideMatch);
            brokerOrder.matched = true;
            brokerOrder.matchMethod = 'bySide';
            this.stats.byMethod.bySide++;
            logger.info(`[Matcher] ✅ Order ${clientOrderId} matched to strategy ${sideMatch.id} by side`);
            return { matched: true, order: brokerOrder };
        }

        const instrumentMatch = this.matchByInstrument(brokerOrder);
        if (instrumentMatch) {
            brokerOrder.strategyId = instrumentMatch.id;
            brokerOrder.role = this.determineRole(brokerOrder, instrumentMatch);
            brokerOrder.matched = true;
            brokerOrder.matchMethod = 'byInstrument';
            this.stats.byMethod.byInstrument++;
            logger.info(`[Matcher] ✅ Order ${clientOrderId} matched to strategy ${instrumentMatch.id} by instrument`);
            return { matched: true, order: brokerOrder };
        }

        logger.warn(`[Matcher] ❌ Cannot match order ${clientOrderId}`);
        return { matched: false, order: brokerOrder };
    }

    matchByInstrumentAndPrice(brokerOrder) {
        let bestMatch = null, bestScore = Infinity;
        for (const [id, strategy] of this.strategies) {
            if (strategy.symbol !== brokerOrder.ticker) continue;
            let expectedPrice = null;
            try {
                if (strategy.calculateBidPrice) expectedPrice = strategy.calculateBidPrice(brokerOrder.price);
                else if (strategy.calculateAskPrice) expectedPrice = strategy.calculateAskPrice(brokerOrder.price);
                else if (strategy.calculatePrice) expectedPrice = strategy.calculatePrice(brokerOrder.price);
            } catch (e) { continue; }
            if (expectedPrice === null) continue;
            const diff = Math.abs(expectedPrice - brokerOrder.price);
            const diffPercent = brokerOrder.price > 0 ? diff / brokerOrder.price : Infinity;
            if (diffPercent < 0.01 && diffPercent < bestScore) {
                bestScore = diffPercent;
                bestMatch = { id, strategy, diff, diffPercent };
            }
        }
        return bestMatch;
    }

    matchByInstrumentAndSide(brokerOrder) {
        const orderSide = brokerOrder.side === 1 ? 'BUY' : 'SELL';
        const candidates = [];
        for (const [id, strategy] of this.strategies) {
            if (strategy.symbol !== brokerOrder.ticker) continue;
            if (strategy.supportsSide) {
                if (strategy.supportsSide(orderSide)) candidates.push({ id, strategy });
            } else {
                candidates.push({ id, strategy });
            }
        }
        return candidates.length === 1 ? candidates[0] : null;
    }

    matchByInstrument(brokerOrder) {
        const candidates = [];
        for (const [id, strategy] of this.strategies) {
            if (strategy.symbol === brokerOrder.ticker) candidates.push({ id, strategy });
        }
        return candidates.length === 1 ? candidates[0] : null;
    }

    determineRole(order, strategyMatch) {
        const side = order.side === 1 ? 'BUY' : 'SELL';
        if (strategyMatch.strategy.determineRole) {
            return strategyMatch.strategy.determineRole(order);
        }
        return side === 'BUY' ? 'BID' : 'ASK';
    }

    async handleUnmatchedOrders(unmatchedOrders) {
        const results = [];
        for (const order of unmatchedOrders) {
            const strategyId = `orphan_${Date.now()}_${order.clientOrderId.slice(0, 8)}`;
            const strategy = {
                id: strategyId,
                symbol: order.ticker,
                classCode: order.classCode,
                isOrphan: true,
                getInfo: () => ({ id: strategyId, symbol: order.ticker, type: 'ORPHAN', isOrphan: true }),
                calculateBidPrice: (price) => price * 0.99,
                calculateAskPrice: (price) => price * 1.01,
            };
            this.strategies.set(strategyId, strategy);
            this.orphanStrategies.set(strategyId, { strategy, order, createdAt: new Date() });
            order.strategyId = strategyId;
            order.role = 'UNKNOWN';
            order.matched = true;
            order.matchMethod = 'orphan';
            await this.globalStack.addOrder(order);
            this.stats.byMethod.orphan++;
            logger.warn(`[Matcher] 🧟 Created orphan strategy ${strategyId} for order ${order.clientOrderId}`);
            results.push({ strategyId, order });
        }
        return results;
    }

    getStats() {
        return {
            ...this.stats,
            orphanStrategies: this.orphanStrategies.size,
            unmatchedCount: this.unmatchedOrders.length,
            orphanDetails: Array.from(this.orphanStrategies.entries()).map(([id, data]) => ({
                strategyId: id,
                orderId: data.order.clientOrderId,
                instrument: data.order.ticker,
                createdAt: data.createdAt
            }))
        };
    }
}

module.exports = OrderMatcher;
