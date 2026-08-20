const EventEmitter = require('events');
const logger = require('../utils/logger');
const OrderIdGenerator = require('../utils/order-id');

class GlobalOrderStack extends EventEmitter {
    constructor(options = {}) {
        super();
        this.orders = new Map();
        this.byStrategy = new Map();
        this.byInstrument = new Map();
        this.byRole = new Map();
        this.bySide = new Map();
        this.byStatus = new Map();
        this.history = [];
        this.maxHistorySize = options.maxHistorySize || 10000;
        this.pendingConfirmations = new Map();
        this.pendingTimeout = options.pendingTimeout || 15000;
        this.isSynced = false;
        this._syncTimer = null;
        this._cleanupTimer = null;
        this.syncInterval = options.syncInterval || 300000;
        this.useDb = options.useDb !== false;
        this.stats = {
            totalAdded: 0,
            totalUpdated: 0,
            totalRemoved: 0,
            syncCount: 0,
            lastSyncTime: null,
        };
    }

    parseOrderId(clientOrderId) {
        return OrderIdGenerator.parse(clientOrderId);
    }

    generateOrderId(strategyId, instrument, side, role) {
        return OrderIdGenerator.generate(strategyId, instrument, side, role);
    }

    async addOrder(orderData) {
        const { clientOrderId } = orderData;
        if (!clientOrderId) {
            logger.warn('[GlobalStack] Cannot add order without clientOrderId');
            return null;
        }

        if (this.orders.has(clientOrderId)) {
            logger.warn(`[GlobalStack] Order ${clientOrderId} already exists, updating`);
            return this.updateOrder(clientOrderId, orderData);
        }

        const metadata = this.parseOrderId(clientOrderId);
        if (metadata) {
            orderData.strategyId = metadata.strategyId || orderData.strategyId;
            orderData.instrument = metadata.instrument || orderData.instrument;
            orderData.side = metadata.side || orderData.side;
            orderData.role = metadata.role || orderData.role;
            orderData.metadata = { ...orderData.metadata, ...metadata };
        }

        const order = {
            ...orderData,
            addedAt: new Date(),
            updatedAt: new Date(),
            isActive: orderData.isActive !== false,
        };

        this.orders.set(clientOrderId, order);
        this.indexOrder(order);
        this.stats.totalAdded++;

        logger.info(`[GlobalStack] Added order: ${clientOrderId} (strategy: ${order.strategyId || 'unknown'}, role: ${order.role || 'unknown'})`);
        this.emit('order_added', order);

        return order;
    }

    indexOrder(order) {
        const { clientOrderId, strategyId, instrument, side, role, status } = order;

        const addToIndex = (map, key, value) => {
            if (!key) return;
            if (!map.has(key)) map.set(key, new Set());
            map.get(key).add(value);
        };

        addToIndex(this.byStrategy, strategyId, clientOrderId);
        addToIndex(this.byInstrument, instrument, clientOrderId);
        addToIndex(this.byRole, role, clientOrderId);
        addToIndex(this.bySide, side?.toUpperCase(), clientOrderId);
        addToIndex(this.byStatus, status, clientOrderId);
    }

    removeFromIndex(order) {
        const { clientOrderId, strategyId, instrument, side, role, status } = order;

        const removeFromIndex = (map, key) => {
            if (!key) return;
            if (map.has(key)) {
                map.get(key).delete(clientOrderId);
                if (map.get(key).size === 0) map.delete(key);
            }
        };

        removeFromIndex(this.byStrategy, strategyId);
        removeFromIndex(this.byInstrument, instrument);
        removeFromIndex(this.byRole, role);
        removeFromIndex(this.bySide, side?.toUpperCase());
        removeFromIndex(this.byStatus, status);
    }

    getOrder(clientOrderId) {
        return this.orders.get(clientOrderId) || null;
    }

    getOrdersForStrategy(strategyId, options = {}) {
        const orderIds = this.byStrategy.get(strategyId) || new Set();
        return this.filterOrders(orderIds, options);
    }

    getOrdersForInstrument(instrument, options = {}) {
        const orderIds = this.byInstrument.get(instrument) || new Set();
        return this.filterOrders(orderIds, options);
    }

    getOrdersByRole(role, options = {}) {
        const orderIds = this.byRole.get(role) || new Set();
        return this.filterOrders(orderIds, options);
    }

    filterOrders(orderIds, options = {}) {
        const result = [];
        for (const id of orderIds) {
            const order = this.orders.get(id);
            if (!order) continue;
            if (options.status && order.status !== options.status) continue;
            if (options.activeOnly && !order.isActive) continue;
            if (options.role && order.role !== options.role) continue;
            if (options.side && order.side !== options.side) continue;
            result.push(order);
        }
        return result;
    }

    getActiveOrders() {
        const result = [];
        for (const [id, order] of this.orders) {
            if (order.isActive !== false && ['PENDING', 'ACTIVE', 'PARTIALLY_FILLED', 'CREATED', 'MODIFIED'].includes(order.status)) {
                result.push(order);
            }
        }
        return result;
    }

    getPendingOrders() {
        const result = [];
        for (const [id, order] of this.orders) {
            if (order.status === 'PENDING' || order.status === 'PENDING_MODIFY' || order.status === 'PENDING_CANCEL') {
                result.push(order);
            }
        }
        return result;
    }

    async updateOrder(clientOrderId, updates) {
        const order = this.orders.get(clientOrderId);
        if (!order) {
            logger.warn(`[GlobalStack] Cannot update: order ${clientOrderId} not found`);
            return null;
        }

        const oldStatus = order.status;
        const newStatus = updates.status || order.status;
        const oldActive = order.isActive;

        Object.assign(order, updates, { updatedAt: new Date() });

        if (oldStatus !== newStatus) {
            this.removeFromIndex({ ...order, status: oldStatus });
            this.indexOrder(order);

            const finalStatuses = ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'REPLACING'];
            if (finalStatuses.includes(newStatus)) {
                order.isActive = false;
            }

            this.addToHistory(order, oldStatus, newStatus);
            this.stats.totalUpdated++;
        }

        if (oldActive !== order.isActive && !order.isActive) {
            this.stats.totalRemoved++;
        }

        logger.info(`[GlobalStack] Updated order ${clientOrderId}: ${oldStatus} → ${newStatus}`);
        this.emit('order_updated', { clientOrderId, oldStatus, newStatus, order });

        return order;
    }

    addPending(order) {
        this.pendingConfirmations.set(order.clientOrderId, {
            order,
            timestamp: Date.now(),
            attempts: 0,
        });
        this.emit('pending_added', order);

        setTimeout(() => {
            if (this.pendingConfirmations.has(order.clientOrderId)) {
                const pending = this.pendingConfirmations.get(order.clientOrderId);
                if (Date.now() - pending.timestamp > this.pendingTimeout) {
                    logger.warn(`[GlobalStack] Pending timeout for ${order.clientOrderId}`);
                    this.pendingConfirmations.delete(order.clientOrderId);
                    this.emit('pending_timeout', order);
                }
            }
        }, this.pendingTimeout);
    }

    confirmOrder(clientOrderId, status, data = null) {
        const pending = this.pendingConfirmations.get(clientOrderId);
        if (!pending) {
            logger.warn(`[GlobalStack] Confirmation for unknown order: ${clientOrderId}`);
            return false;
        }
        this.pendingConfirmations.delete(clientOrderId);
        return this.updateOrder(clientOrderId, { status, confirmedAt: new Date(), wsConfirmed: true, ...data });
    }

    isPending(clientOrderId) {
        return this.pendingConfirmations.has(clientOrderId);
    }

    addToHistory(order, oldStatus, newStatus) {
        this.history.push({ ...order, oldStatus, newStatus, changedAt: new Date() });
        if (this.history.length > this.maxHistorySize) this.history.shift();
    }

    getHistory(limit = 50) {
        return this.history.slice(-limit);
    }

    async syncWithBroker(brokerAdapter) {
        logger.info('[GlobalStack] Starting sync with broker...');
        this.stats.syncCount++;

        try {
            const brokerOrders = await brokerAdapter.getActiveOrdersWithDetails();
            const brokerMap = new Map();
            for (const order of brokerOrders) {
                brokerMap.set(order.clientOrderId, order);
            }

            let updatedCount = 0, addedCount = 0, removedCount = 0;

            for (const [id, order] of this.orders) {
                const brokerOrder = brokerMap.get(id);
                if (!brokerOrder) {
                    if (order.isActive) {
                        logger.warn(`[GlobalStack] Order ${id} not found at broker, marking as closed`);
                        await this.updateOrder(id, { status: 'EXPIRED', isActive: false });
                        removedCount++;
                    }
                    continue;
                }

                const brokerStatus = String(brokerOrder.orderStatus);
                const currentStatus = String(order.orderStatus || order.status);

                if (brokerStatus !== currentStatus) {
                    logger.info(`[GlobalStack] Order ${id} status changed: ${currentStatus} → ${brokerStatus}`);
                    await this.updateOrder(id, {
                        status: brokerOrder.status || this.mapBrokerStatus(brokerStatus),
                        orderStatus: brokerStatus,
                        brokerOrderId: brokerOrder.brokerOrderId || brokerOrder.orderId,
                        price: brokerOrder.price,
                        filledQuantity: brokerOrder.filledQuantity || 0,
                        remainingQuantity: brokerOrder.remainingQuantity || 0,
                    });
                    updatedCount++;
                }
            }

            for (const [id, brokerOrder] of brokerMap) {
                if (!this.orders.has(id)) {
                    logger.info(`[GlobalStack] Found new order from broker: ${id}`);
                    await this.addOrder(brokerOrder);
                    addedCount++;
                }
            }

            this.isSynced = true;
            this.stats.lastSyncTime = new Date();
            logger.info(`[GlobalStack] Sync completed: ${updatedCount} updated, ${addedCount} added, ${removedCount} removed`);
            this.emit('sync_completed', { updatedCount, addedCount, removedCount });

        } catch (error) {
            logger.err(`[GlobalStack] Sync failed: ${error.message}`);
            this.emit('sync_error', error);
        }
    }

    mapBrokerStatus(brokerStatus) {
        const map = {
            '0': 'CREATED', '1': 'PARTIALLY_FILLED', '2': 'FILLED',
            '3': 'ACTIVE', '4': 'CANCELLED', '5': 'REPLACED',
            '7': 'REJECTED', '8': 'ERROR', '9': 'REPLACING'
        };
        return map[String(brokerStatus)] || 'UNKNOWN';
    }

    startAutoSync(brokerAdapter) {
        if (this._syncTimer) clearInterval(this._syncTimer);
        this._syncTimer = setInterval(() => this.syncWithBroker(brokerAdapter), this.syncInterval);
        logger.info(`[GlobalStack] Auto-sync started (interval: ${this.syncInterval / 1000}s)`);
    }

    stopAutoSync() {
        if (this._syncTimer) { clearInterval(this._syncTimer); this._syncTimer = null; }
        logger.info('[GlobalStack] Auto-sync stopped');
    }

    startCleanup() {
        if (this._cleanupTimer) clearInterval(this._cleanupTimer);
        this._cleanupTimer = setInterval(() => this.cleanStalePending(), 10000);
        logger.info('[GlobalStack] Cleanup started');
    }

    stopCleanup() {
        if (this._cleanupTimer) { clearInterval(this._cleanupTimer); this._cleanupTimer = null; }
        logger.info('[GlobalStack] Cleanup stopped');
    }

    cleanStalePending() {
        const now = Date.now();
        const cleaned = [];
        for (const [id, pending] of this.pendingConfirmations) {
            if (now - pending.timestamp > this.pendingTimeout) {
                this.pendingConfirmations.delete(id);
                cleaned.push(id);
            }
        }
        if (cleaned.length > 0) {
            logger.debug(`[GlobalStack] Cleaned ${cleaned.length} stale pending orders`);
            this.emit('stale_cleaned', cleaned);
        }
        return cleaned;
    }

    getStats() {
        const active = this.getActiveOrders();
        const pending = this.getPendingOrders();
        const byStatus = {};
        for (const [status, ids] of this.byStatus) byStatus[status] = ids.size;

        return {
            totalOrders: this.orders.size,
            activeOrders: active.length,
            pendingOrders: pending.length,
            historySize: this.history.length,
            isSynced: this.isSynced,
            stats: this.stats,
            byStrategy: Array.from(this.byStrategy.entries()).map(([id, set]) => ({ strategyId: id, count: set.size })),
            byStatus,
            byRole: Array.from(this.byRole.entries()).map(([role, set]) => ({ role, count: set.size })),
            byInstrument: Array.from(this.byInstrument.entries()).map(([inst, set]) => ({ instrument: inst, count: set.size })),
        };
    }

    clear() {
        this.orders.clear();
        this.byStrategy.clear();
        this.byInstrument.clear();
        this.byRole.clear();
        this.bySide.clear();
        this.byStatus.clear();
        this.pendingConfirmations.clear();
        this.history = [];
        this.isSynced = false;
        this.stats = { totalAdded: 0, totalUpdated: 0, totalRemoved: 0, syncCount: 0, lastSyncTime: null };
        logger.info('[GlobalStack] Cleared all orders');
    }
}

module.exports = GlobalOrderStack;
