const logger = require('../utils/logger');

class StrategyRegistry {
    constructor() {
        this.strategies = new Map();
        this.evaluator = null;
    }

    setEvaluator(evaluator) {
        this.evaluator = evaluator;
        for (const [id, { strategy, condition }] of this.strategies) {
            evaluator.registerStrategy(strategy, condition);
        }
        logger.info(`[Registry] Connected to evaluator, ${this.strategies.size} strategies registered`);
    }

    register(strategy, conditionFn) {
        if (this.strategies.has(strategy.id)) {
            logger.warn(`[Registry] Strategy ${strategy.id} already registered, replacing`);
        }
        this.strategies.set(strategy.id, { strategy, condition: conditionFn });
        if (this.evaluator) {
            this.evaluator.registerStrategy(strategy, conditionFn);
        }
        logger.ok(`[Registry] Strategy registered: ${strategy.id} (${strategy.symbol})`);
        return this;
    }

    get(id) {
        return this.strategies.get(id)?.strategy || null;
    }

    getAll() {
        return Array.from(this.strategies.values()).map(({ strategy }) => strategy);
    }

    getInfo() {
        return Array.from(this.strategies.entries()).map(([id, { strategy }]) => ({
            id,
            info: strategy.getInfo ? strategy.getInfo() : {
                symbol: strategy.symbol,
                type: strategy.constructor.name
            }
        }));
    }

    remove(id) {
        if (!this.strategies.has(id)) return false;
        this.strategies.delete(id);
        logger.info(`[Registry] Strategy removed: ${id}`);
        return true;
    }

    resetAll() {
        for (const [, { strategy }] of this.strategies) {
            if (strategy.reset) strategy.reset();
        }
        logger.info('[Registry] All strategies reset');
    }

    size() {
        return this.strategies.size;
    }
}

module.exports = new StrategyRegistry();
