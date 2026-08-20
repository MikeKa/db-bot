const EventEmitter = require('events');
const OrderStack = require('./order-stack');
const logger = require('../../utils/logger');
const { ExecutionRequest } = require('../interfaces');
const { v4: uuidv4 } = require('uuid');

class OrderManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.stacks = new Map();
        this.globalHistory = [];
        this.maxHistorySize = options.maxHistorySize || 2000;
        this.defaultLimits = {
            maxActiveOrders: options.maxActiveOrders || 2,
            maxOrderValue: options.maxOrderValue || Infinity
        };
        this.strategyLimits = new Map();
        this.idempotencyCache = new Map();
        this.idempotencyTTL = options.idempotencyTTL || 60000;
        this.brokerAdapter = null;
        this.riskManager = null;
        this.executionQueue = null;
        this._cancelMap = new Map();
        this.useDb = options.useDb !== false;
    }

    setBrokerAdapter(adapter) { this.brokerAdapter = adapter; }
    setRiskManager(riskManager) { this.riskManager = riskManager; }
    setExecutionQueue(queue) { this.executionQueue = queue; }

    getStack(strategyId) {
        if (!this.stacks.has(strategyId)) {
            const stack = new OrderStack(strategyId, { useDb: this.useDb });
            this.stacks.set(strategyId, stack);

            stack.on('order_confirmed', (order) => {
                this.emit('order_confirmed', { strategyId, order });
                this.emit('stack_updated', { strategyId, order });
            });
            stack.on('order_filled', (order) => {
                this.emit('order_filled', { strategyId, order });
                this.emit('stack_updated', { strategyId, order });
            });
            stack.on('order_closed', (order) => {
                this.emit('order_closed', { strategyId, order });
                this.emit('stack_updated', { strategyId, order });
            });
            stack.on('order_updated', (order) => {
                this.emit('order_updated', { strategyId, order });
                this.emit('stack_updated', { strategyId, order });
            });
            stack.on('order_error', (data) => this.emit('order_error', { strategyId, data }));
            stack.on('emergency_stop', (data) => this.emit('emergency_stop', data));
            stack.on('sync_status_changed', (data) => this.emit('sync_status_changed', data));
            stack.on('ws_disconnected', (data) => this.emit('ws_disconnected', data));
            stack.on('ws_reconnected', (data) => this.emit('ws_reconnected', data));
            stack.on('emergency_stop_triggered', (data) => this.emit('emergency_stop_triggered', data));
        }
        return this.stacks.get(strategyId);
    }

    async initializeAll(strategies) {
        if (!this.brokerAdapter) throw new Error('BrokerAdapter not set');
        const results = [];
        for (const strategy of strategies) {
            try {
                const stack = this.getStack(strategy.id);
                await stack.initialize(this.brokerAdapter);
                results.push({ strategyId: strategy.id, success: true });
            } catch (e) {
                logger.err(`[${strategy.id}] Failed to initialize: ${e.message}`);
                results.push({ strategyId: strategy.id, success: false, error: e.message });
            }
        }
        return results;
    }

    setStrategyLimit(strategyId, limit) {
        this.strategyLimits.set(strategyId, { ...this.defaultLimits, ...limit });
    }

    getStrategyLimit(strategyId) {
        return this.strategyLimits.get(strategyId) || this.defaultLimits;
    }

    checkLimits(strategyId, intent) {
        const limits = this.getStrategyLimit(strategyId);
        const stack = this.getStack(strategyId);
        const activeOrders = stack.getValidActiveOrders();
        if (activeOrders.length >= limits.maxActiveOrders) {
            return {
                allowed: false,
                reason: `Max active orders exceeded (${limits.maxActiveOrders})`,
                action: 'MODIFY'
            };
        }
        const totalValue = activeOrders.reduce((sum, o) => sum + (o.price * o.quantity), 0);
        const newValue = intent.price * intent.quantity;
        if (totalValue + newValue > limits.maxOrderValue) {
            return {
                allowed: false,
                reason: `Max order value exceeded (${limits.maxOrderValue})`,
                action: 'MODIFY'
            };
        }
        return { allowed: true };
    }

    isDuplicate(intentId) {
        if (this.idempotencyCache.has(intentId)) return true;
        this.idempotencyCache.set(intentId, true);
        setTimeout(() => this.idempotencyCache.delete(intentId), this.idempotencyTTL);
        return false;
    }

    canOperate(strategyId) {
        const stack = this.getStack(strategyId);
        if (!stack) return false;
        return stack.canOperate();
    }

    isSynced(strategyId) {
        const stack = this.getStack(strategyId);
        if (!stack) return false;
        return stack.isSynced();
    }

    processIntent(intent) {
        const { strategyId, action } = intent;

        if (this.isDuplicate(intent.intentId)) {
            logger.warn(`[${strategyId}] Duplicate intent: ${intent.intentId}`);
            return { action: 'SKIP', reason: 'Duplicate intent', intentId: intent.intentId };
        }

        const stack = this.getStack(strategyId);

        // Проверяем синхронизацию - но не блокируем CREATE, если нет активных заявок
        // Блокируем только если есть рассинхрон или ошибка
        const syncStatus = stack.getSyncStatus();
        if (syncStatus.status === 'ERROR' || syncStatus.status === 'EMERGENCY_STOP') {
            logger.warn(`[${strategyId}] Cannot process intent: sync error`);
            return {
                action: 'BLOCKED',
                reason: `Sync error: ${syncStatus.status}`,
                intentId: intent.intentId,
                syncStatus: syncStatus
            };
        }

        // Если есть pending заявки, блокируем только MODIFY и CANCEL
        // CREATE разрешен, если нет активных заявок
        if (stack.pendingConfirmations.size > 0) {
            if (action === 'CREATE' && stack.hasActiveOrders()) {
                logger.warn(`[${strategyId}] Cannot CREATE: active orders exist and pending confirmations`);
                return {
                    action: 'BLOCKED',
                    reason: 'Active orders with pending confirmations',
                    intentId: intent.intentId
                };
            }
            if (action === 'MODIFY' || action === 'CANCEL') {
                logger.warn(`[${strategyId}] Cannot ${action}: pending confirmations exist`);
                return {
                    action: 'BLOCKED',
                    reason: 'Pending confirmations exist',
                    intentId: intent.intentId
                };
            }
        }

        switch (action) {
            case 'CANCEL': return this.handleCancel(intent, stack);
            case 'CREATE': return this.handleCreate(intent, stack);
            case 'MODIFY': return this.handleModify(intent, stack);
            default: return { action: 'REJECT', reason: `Unknown action: ${action}`, intentId: intent.intentId };
        }
    }

    handleCreate(intent, stack) {
        const strategyId = intent.strategyId;
        const limits = this.checkLimits(strategyId, intent);
        if (!limits.allowed) {
            if (limits.action === 'MODIFY' && stack.hasActiveOrders()) {
                const existingOrder = stack.getLatestOrder();
                logger.info(`[${strategyId}] Limit exceeded, modifying existing order instead`);
                return this.handleModifyWithExisting(intent, stack, existingOrder);
            }
            return { action: 'REJECT', reason: limits.reason, intentId: intent.intentId };
        }

        const request = new ExecutionRequest({
            intentId: intent.intentId,
            strategyId: intent.strategyId,
            action: 'CREATE',
            symbol: intent.symbol,
            classCode: intent.classCode || 'TQBR',
            side: intent.side,
            price: intent.price,
            quantity: intent.quantity,
            orderType: intent.orderType,
            metadata: intent.metadata,
        });

        if (this.riskManager) {
            const riskCheck = this.riskManager.validate(request);
            if (!riskCheck.approved) {
                return { action: 'REJECT', reason: riskCheck.reason, intentId: intent.intentId };
            }
            request.riskApproved = true;
            request.riskMetadata = riskCheck.metadata || {};
        }

        const orderData = {
            clientOrderId: request.clientOrderId,
            price: request.price,
            quantity: request.quantity,
            status: 'PENDING',
            createdAt: new Date(),
            strategyId: request.strategyId,
            symbol: request.symbol,
            side: request.side,
            orderType: request.orderType,
            metadata: request.metadata,
            replaces: null,
        };

        stack.addPending(orderData);
        stack.saveOrderToDb(orderData);

        if (this.executionQueue) this.executionQueue.enqueue(request);
        return {
            action: 'CREATE',
            requestId: request.requestId,
            clientOrderId: request.clientOrderId,
            intentId: intent.intentId
        };
    }

    handleModify(intent, stack) {
        const strategyId = intent.strategyId;

        if (intent.orderId) {
            const existingOrder = stack.getOrder(intent.orderId);
            if (!existingOrder) {
                logger.warn(`[${strategyId}] Order ${intent.orderId} not found, creating new`);
                return this.handleCreate(intent, stack);
            }

            const orderForModify = stack.getOrderForModify(intent.orderId);
            if (!orderForModify) {
                const order = stack.getOrder(intent.orderId);
                if (order && ['ERROR', 'REJECTED'].includes(order.status) && (order.attempts || 0) >= 3) {
                    logger.warn(`[${strategyId}] Order ${intent.orderId} has too many attempts, removing`);
                    order.status = 'REPLACED';
                    stack.addToHistory(order);
                    stack.orders.delete(intent.orderId);
                    stack.deleteOrderFromDb(intent.orderId);
                    return this.handleCreate(intent, stack);
                }
                logger.warn(`[${strategyId}] Order ${intent.orderId} cannot be modified, creating new`);
                return this.handleCreate(intent, stack);
            }

            if (orderForModify.price === intent.price) {
                logger.info(`[${strategyId}] Price unchanged for ${intent.orderId}, skipping modify`);
                return { action: 'SKIP', reason: 'Price unchanged', intentId: intent.intentId };
            }

            return this.executeModify(intent, stack, orderForModify);
        }

        const activeOrders = stack.getValidActiveOrders();
        if (activeOrders.length === 0) {
            logger.info(`[${strategyId}] No active orders, creating instead`);
            return this.handleCreate(intent, stack);
        }

        const existingOrder = activeOrders[activeOrders.length - 1];
        if (!stack.canModifyOrder(existingOrder.clientOrderId)) {
            logger.warn(`[${strategyId}] Order ${existingOrder.clientOrderId} cannot be modified, removing and creating new`);
            const order = stack.getOrder(existingOrder.clientOrderId);
            if (order) {
                order.status = 'REPLACED';
                stack.addToHistory(order);
                stack.orders.delete(existingOrder.clientOrderId);
                stack.deleteOrderFromDb(existingOrder.clientOrderId);
            }
            return this.handleCreate(intent, stack);
        }

        if (existingOrder.price === intent.price) {
            logger.info(`[${strategyId}] Price unchanged, skipping modify`);
            return { action: 'SKIP', reason: 'Price unchanged', intentId: intent.intentId };
        }

        return this.executeModify(intent, stack, existingOrder);
    }

    executeModify(intent, stack, existingOrder) {
        const strategyId = intent.strategyId;

        if (stack.isPending(existingOrder.clientOrderId)) {
            logger.warn(`[${strategyId}] Order ${existingOrder.clientOrderId} is pending, skipping modify`);
            return { action: 'SKIP', reason: 'Order is pending', intentId: intent.intentId };
        }

        const currentOrder = stack.getOrder(existingOrder.clientOrderId);
        if (!currentOrder) {
            logger.warn(`[${strategyId}] Order ${existingOrder.clientOrderId} no longer exists, creating new`);
            return this.handleCreate(intent, stack);
        }

        if (stack.isFinalStatus(currentOrder.status)) {
            logger.warn(`[${strategyId}] Order ${existingOrder.clientOrderId} is ${currentOrder.status}, creating new instead of modifying`);
            return this.handleCreate(intent, stack);
        }

        if (currentOrder.price === intent.price) {
            logger.info(`[${strategyId}] Price unchanged, skipping modify`);
            return { action: 'SKIP', reason: 'Price unchanged', intentId: intent.intentId };
        }

        const brokerOrderId = currentOrder.brokerOrderId || currentOrder.orderId;
        if (!brokerOrderId || brokerOrderId === currentOrder.clientOrderId) {
            logger.warn(`[${strategyId}] Order ${currentOrder.clientOrderId} has no brokerOrderId, cannot modify`);
            return this.handleCreate(intent, stack);
        }

        const newClientOrderId = uuidv4();
        const request = new ExecutionRequest({
            intentId: intent.intentId,
            strategyId: intent.strategyId,
            action: 'MODIFY',
            symbol: intent.symbol,
            classCode: intent.classCode || 'TQBR',
            side: intent.side,
            price: intent.price,
            quantity: intent.quantity,
            orderType: intent.orderType,
            orderId: brokerOrderId,
            clientOrderId: newClientOrderId,
            metadata: {
                ...intent.metadata,
                oldClientOrderId: currentOrder.clientOrderId,
                brokerOrderId: brokerOrderId
            },
        });

        if (this.riskManager) {
            const riskCheck = this.riskManager.validate(request);
            if (!riskCheck.approved) {
                return { action: 'REJECT', reason: riskCheck.reason, intentId: intent.intentId };
            }
            request.riskApproved = true;
            request.riskMetadata = riskCheck.metadata || {};
        }

        stack.addPending({
            clientOrderId: request.clientOrderId,
            price: request.price,
            quantity: request.quantity,
            status: 'PENDING_MODIFY',
            createdAt: new Date(),
            strategyId: request.strategyId,
            symbol: request.symbol,
            side: request.side,
            orderType: request.orderType,
            metadata: request.metadata,
            replaces: currentOrder.clientOrderId,
            brokerOrderId: brokerOrderId,
        });

        if (this.executionQueue) this.executionQueue.enqueue(request);
        return {
            action: 'MODIFY',
            requestId: request.requestId,
            clientOrderId: request.clientOrderId,
            replacesOrderId: currentOrder.clientOrderId,
            brokerOrderId: brokerOrderId,
            intentId: intent.intentId
        };
    }

    handleModifyWithExisting(intent, stack, existingOrder) {
        const strategyId = intent.strategyId;
        const orderForModify = stack.getOrderForModify(existingOrder.clientOrderId);
        if (!orderForModify) {
            logger.warn(`[${strategyId}] Order ${existingOrder.clientOrderId} cannot be modified`);
            if (existingOrder.attempts >= 3) {
                stack.emergencyStopStrategy(
                    `Order ${existingOrder.clientOrderId} cannot be modified after ${existingOrder.attempts} attempts`,
                    {
                        order: {
                            clientOrderId: existingOrder.clientOrderId,
                            price: existingOrder.price,
                            quantity: existingOrder.quantity,
                            status: existingOrder.status,
                            attempts: existingOrder.attempts
                        },
                        intent: intent
                    }
                );
                return { action: 'STOP', reason: 'Emergency stop triggered' };
            }
            logger.info(`[${strategyId}] Creating new order instead of modifying`);
            return this.handleCreate(intent, stack);
        }
        if (orderForModify.price === intent.price) {
            logger.info(`[${strategyId}] Price unchanged, skipping modify`);
            return { action: 'SKIP', reason: 'Price unchanged', intentId: intent.intentId };
        }
        if (['ERROR', 'REJECTED'].includes(orderForModify.status)) {
            logger.info(`[${strategyId}] Attempting to recover order ${orderForModify.clientOrderId} from ${orderForModify.status}`);
            orderForModify.status = 'PENDING_MODIFY';
            orderForModify.attempts = (orderForModify.attempts || 0) + 1;
        }
        return this.executeModify(intent, stack, orderForModify);
    }

    handleCancel(intent, stack) {
        const strategyId = intent.strategyId;

        if (intent.orderId) {
            const order = stack.getOrder(intent.orderId);
            if (!order) {
                return { action: 'REJECT', reason: `Order ${intent.orderId} not found`, intentId: intent.intentId };
            }
            if (!stack.isActiveStatus(order.status) && order.status !== 'ERROR' && order.status !== 'REJECTED') {
                return {
                    action: 'SKIP',
                    reason: `Order ${intent.orderId} is not active (status: ${order.status})`,
                    intentId: intent.intentId
                };
            }
            return this.cancelOrder(intent.orderId, stack);
        }

        if (!stack.hasActiveOrders()) {
            return { action: 'SKIP', reason: 'No active orders to cancel', intentId: intent.intentId };
        }

        const results = [];
        for (const order of stack.getActiveOrders()) {
            const result = this.cancelOrder(order.clientOrderId, stack);
            results.push(result);
        }
        return { action: 'CANCEL_ALL', results, intentId: intent.intentId };
    }

    cancelOrder(clientOrderId, stack) {
        const order = stack.getOrder(clientOrderId);
        if (!order) {
            return { success: false, reason: 'Order not found', clientOrderId };
        }
        if (!stack.isActiveStatus(order.status) && order.status !== 'ERROR' && order.status !== 'REJECTED') {
            return {
                success: false,
                reason: `Order ${clientOrderId} is not active (status: ${order.status})`,
                clientOrderId
            };
        }

        const brokerOrderId = order.brokerOrderId || order.orderId;
        const orderIdForCancel = brokerOrderId || clientOrderId;
        const cancelClientId = uuidv4();

        stack.addPending({
            clientOrderId: cancelClientId,
            price: order.price,
            quantity: order.quantity,
            status: 'PENDING_CANCEL',
            createdAt: new Date(),
            strategyId: stack.strategyId,
            symbol: order.symbol,
            side: order.side,
            orderType: order.orderType,
            metadata: order.metadata,
            originalOrderId: clientOrderId,
            originalBrokerOrderId: brokerOrderId,
            replaces: null,
        });

        this._cancelMap.set(cancelClientId, clientOrderId);

        const request = new ExecutionRequest({
            intentId: `cancel_${clientOrderId}_${Date.now()}`,
            strategyId: stack.strategyId,
            action: 'CANCEL',
            symbol: order.symbol || 'SBER',
            classCode: order.classCode || 'TQBR',
            side: 'BUY',
            price: order.price,
            quantity: order.quantity,
            orderId: orderIdForCancel,
            clientOrderId: cancelClientId,
            metadata: {
                originalOrderId: clientOrderId,
                originalBrokerOrderId: brokerOrderId,
                cancelClientId: cancelClientId
            },
        });

        if (this.executionQueue) this.executionQueue.enqueue(request);
        return {
            success: true,
            clientOrderId,
            requestId: request.requestId,
            cancelClientId,
            brokerOrderId: brokerOrderId
        };
    }

    syncWithWs(event) {
        const { clientOrderId } = event;
        if (!clientOrderId) {
            logger.warn(`[OrderManager] WS event without clientOrderId`);
            return;
        }

        for (const [id, stack] of this.stacks) {
            if (stack.getOrder(clientOrderId) || stack.isPending(clientOrderId)) {
                event.strategyId = id;
                stack.syncWithWs(event);
                const order = stack.getOrder(clientOrderId);
                if (order) {
                    this.emit('stack_updated', { strategyId: id, order });
                }
                return;
            }
        }

        logger.warn(`[OrderManager] Unknown order from WS: ${clientOrderId}`);
    }

    getActiveOrders(strategyId = null) {
        if (strategyId) {
            const stack = this.getStack(strategyId);
            return stack.getActiveOrders();
        }
        const all = [];
        for (const [id, stack] of this.stacks) {
            const active = stack.getActiveOrders();
            all.push(...active.map(o => ({ ...o, strategyId: id })));
        }
        return all;
    }

    getValidActiveOrders(strategyId = null) {
        if (strategyId) {
            const stack = this.getStack(strategyId);
            return stack.getValidActiveOrders();
        }
        const all = [];
        for (const [id, stack] of this.stacks) {
            const active = stack.getValidActiveOrders();
            all.push(...active.map(o => ({ ...o, strategyId: id })));
        }
        return all;
    }

    getLatestOrder(strategyId) {
        return this.getStack(strategyId).getLatestOrder();
    }

    getOrder(strategyId, clientOrderId) {
        const stack = this.getStack(strategyId);
        return stack.getOrder(clientOrderId);
    }

    getHistory(strategyId = null, limit = 50) {
        if (strategyId) {
            return this.getStack(strategyId).getHistory(limit);
        }
        const all = [];
        for (const [id, stack] of this.stacks) {
            all.push(...stack.getHistory(limit).map(o => ({ ...o, strategyId: id })));
        }
        all.sort((a, b) => b.archivedAt - a.archivedAt);
        return all.slice(0, limit);
    }

    getStats() {
        const stacks = {};
        for (const [id, stack] of this.stacks) {
            stacks[id] = stack.getStats();
        }
        return {
            stacks,
            totalActive: Array.from(this.stacks.values()).reduce((acc, s) => acc + s.getActiveCount(), 0),
            totalPending: Array.from(this.stacks.values()).reduce((acc, s) => acc + s.pendingConfirmations.size, 0),
            idempotencyCacheSize: this.idempotencyCache.size
        };
    }

    getSyncStatus() {
        const result = {};
        for (const [id, stack] of this.stacks) {
            result[id] = stack.getSyncStatus();
        }
        return result;
    }

    reset(strategyId = null) {
        if (strategyId) {
            const stack = this.stacks.get(strategyId);
            if (stack) stack.reset();
            return;
        }
        for (const [id, stack] of this.stacks) stack.reset();
        this.stacks.clear();
        this.idempotencyCache.clear();
        this._cancelMap.clear();
    }

    shutdown() {
        for (const [id, stack] of this.stacks) {
            stack.stopCleanup();
            stack.stopWsHealthCheck();
        }
    }
}

module.exports = OrderManager;