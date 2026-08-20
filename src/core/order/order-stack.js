const EventEmitter = require('events');
const logger = require('../../utils/logger');
const db = require('../../db');

class OrderStack extends EventEmitter {
    constructor(strategyId, options = {}) {
        super();
        this.strategyId = strategyId;
        this.orders = new Map();
        this.pendingConfirmations = new Map();
        this.history = [];
        this.maxHistorySize = options.maxHistorySize || 1000;
        this._initialized = false;
        this.pendingTimeout = options.pendingTimeout || 15000;
        this._cleanupTimer = null;
        this._isWsSynced = true;
        this._lastWsSyncTime = 0;
        this._pendingSyncOrders = new Map();
        this._pendingWsConfirmations = new Map();
        this.useDb = options.useDb !== false;

        // ============================================================
        // КОНТРОЛЬ WS СОЕДИНЕНИЯ - ЧЕРЕЗ PING-PONG
        // ============================================================
        this._ws = null;
        this._wsConnected = true;
        this._wsLastPongTime = Date.now();
        this._wsPingInterval = 30000;
        this._wsPingTimeout = 10000;
        this._wsPingTimer = null;
        this._wsPingTimeoutTimer = null;
        this._brokerAdapter = null;

        this._restFallbackActive = false;
        this._restRetryCount = 0;
        this._restRetryDelay = 2000;
        this._maxRestRetryDelay = 120000;
        this._lastRestSyncTime = 0;
        this._restSyncInProgress = false;
        this._emergencyStopTriggered = false;

        this._syncStatus = {
            status: 'SYNCED',
            lastUpdate: null,
            lastError: null,
            brokerCount: 0,
            stackCount: 0,
            dbCount: 0,
            wsConnected: true,
            restFallback: false,
            pendingCount: 0,
            canOperate: true,
            isSynced: true,
            mismatches: [],
            restRetryCount: 0,
            restRetryDelay: 2000
        };
    }

    // ============================================================
    // УСТАНОВКА WS СОЕДИНЕНИЯ ДЛЯ PING-PONG
    // ============================================================
    setWsConnection(ws) {
        this._ws = ws;
        this._brokerAdapter = this._brokerAdapter || null;

        if (!ws) {
            this._wsConnected = false;
            this.updateSyncStatus('ERROR');
            return;
        }

        ws.on('pong', () => {
            this._wsLastPongTime = Date.now();
            if (!this._wsConnected) {
                this._wsConnected = true;
                this._restFallbackActive = false;
                this._restRetryCount = 0;
                this._restRetryDelay = 2000;
                this._syncStatus.wsConnected = true;
                this._syncStatus.restFallback = false;
                this.updateSyncStatus('SYNCED');
                this.emit('ws_reconnected', {
                    strategyId: this.strategyId,
                    timestamp: new Date()
                });
                logger.ok(`[${this.strategyId}] ✅ WS connection restored via pong`);
            }
        });

        ws.on('close', () => {
            this._wsConnected = false;
            this._syncStatus.wsConnected = false;
            this.updateSyncStatus('ERROR');
            this.emit('ws_disconnected', {
                strategyId: this.strategyId,
                timestamp: new Date()
            });
            logger.warn(`[${this.strategyId}] ⚠️ WS closed`);
        });

        ws.on('error', (error) => {
            logger.warn(`[${this.strategyId}] ❌ WS error: ${error.message}`);
        });

        this.startPingPong();
    }

    // ============================================================
    // ЗАПУСК PING-PONG
    // ============================================================
    startPingPong() {
        if (this._wsPingTimer) clearInterval(this._wsPingTimer);
        if (this._wsPingTimeoutTimer) clearTimeout(this._wsPingTimeoutTimer);

        this._wsPingTimer = setInterval(() => {
            if (!this._ws || this._ws.readyState !== 1) { // WebSocket.OPEN = 1
                this._wsConnected = false;
                this._syncStatus.wsConnected = false;
                this.updateSyncStatus('ERROR');
                this.emit('ws_disconnected', {
                    strategyId: this.strategyId,
                    timestamp: new Date()
                });
                return;
            }

            try {
                this._ws.ping();
                logger.debug(`[${this.strategyId}] 📤 Ping sent`);

                if (this._wsPingTimeoutTimer) clearTimeout(this._wsPingTimeoutTimer);

                this._wsPingTimeoutTimer = setTimeout(() => {
                    if (this._wsConnected) {
                        this._wsConnected = false;
                        this._syncStatus.wsConnected = false;
                        this._restFallbackActive = true;
                        this._syncStatus.restFallback = true;
                        this.updateSyncStatus('SYNCING');
                        this.emit('ws_disconnected', {
                            strategyId: this.strategyId,
                            reason: 'ping timeout',
                            timestamp: new Date()
                        });
                        logger.warn(`[${this.strategyId}] ⚠️ WS ping timeout - connection lost`);

                        if (this._brokerAdapter) {
                            this.syncWithRestFallback(this._brokerAdapter);
                        }
                    }
                }, this._wsPingTimeout);

            } catch (e) {
                logger.warn(`[${this.strategyId}] ❌ Ping failed: ${e.message}`);
                this._wsConnected = false;
                this._syncStatus.wsConnected = false;
                this.updateSyncStatus('ERROR');
                this.emit('ws_disconnected', {
                    strategyId: this.strategyId,
                    error: e.message,
                    timestamp: new Date()
                });
            }

        }, this._wsPingInterval);

        logger.info(`[${this.strategyId}] Ping-pong started (interval: ${this._wsPingInterval / 1000}s, timeout: ${this._wsPingTimeout / 1000}s)`);
    }

    stopPingPong() {
        if (this._wsPingTimer) {
            clearInterval(this._wsPingTimer);
            this._wsPingTimer = null;
        }
        if (this._wsPingTimeoutTimer) {
            clearTimeout(this._wsPingTimeoutTimer);
            this._wsPingTimeoutTimer = null;
        }
    }

    // ============================================================
    // REST FALLBACK
    // ============================================================
    setBrokerAdapter(brokerAdapter) {
        this._brokerAdapter = brokerAdapter;
    }

    async syncWithRestFallback(brokerAdapter) {
        if (this._restSyncInProgress) return;
        this._restSyncInProgress = true;

        try {
            logger.info(`[${this.strategyId}] 🔄 REST fallback sync (attempt ${this._restRetryCount + 1})`);

            const brokerOrders = await brokerAdapter.syncOrdersByList({ strategyId: this.strategyId });
            const brokerMap = new Map();
            for (const order of brokerOrders) {
                const activeStatuses = ['0', '1', '3', '5'];
                if (activeStatuses.includes(order.orderStatus) && order.orderStatus !== '9') {
                    brokerMap.set(order.clientOrderId, order);
                }
            }

            let changesDetected = false;

            for (const [id, order] of this.orders) {
                if (!brokerMap.has(id)) {
                    logger.warn(`[${this.strategyId}] 📌 REST sync: Order ${id} not found at broker - removing`);
                    this.orders.delete(id);
                    this.deleteOrderFromDb(id);
                    changesDetected = true;
                }
            }

            for (const [id, brokerOrder] of brokerMap) {
                if (!this.orders.has(id)) {
                    logger.info(`[${this.strategyId}] 📌 REST sync: Found new order from broker: ${id}`);
                    this.orders.set(id, brokerOrder);
                    this.saveOrderToDb(brokerOrder);
                    changesDetected = true;
                }
            }

            for (const [id, brokerOrder] of brokerMap) {
                if (this.orders.has(id)) {
                    const currentOrder = this.orders.get(id);
                    const currentStatus = String(currentOrder.orderStatus || currentOrder.status);
                    const newStatus = String(brokerOrder.orderStatus || brokerOrder.status);

                    if (currentStatus !== newStatus) {
                        logger.warn(`[${this.strategyId}] 📌 REST sync: Order ${id} status changed: ${currentStatus} → ${newStatus}`);
                        currentOrder.status = brokerOrder.status || newStatus;
                        currentOrder.orderStatus = brokerOrder.orderStatus || newStatus;
                        this.orders.set(id, currentOrder);
                        this.saveOrderToDb(currentOrder);
                        changesDetected = true;
                    }
                }
            }

            if (changesDetected) {
                logger.info(`[${this.strategyId}] ✅ REST sync completed with changes`);
                this.emit('rest_sync_completed', {
                    strategyId: this.strategyId,
                    changes: true,
                    timestamp: new Date()
                });
            } else {
                logger.debug(`[${this.strategyId}] ✅ REST sync completed - no changes`);
            }

            this._restRetryCount = 0;
            this._restRetryDelay = 2000;
            this._lastRestSyncTime = Date.now();
            this.updateSyncStatus('SYNCED');

        } catch (e) {
            logger.err(`[${this.strategyId}] ❌ REST sync failed: ${e.message}`);
            this._restRetryCount++;
            this._restRetryDelay = Math.min(
                this._restRetryDelay * 1.5 + 1000,
                this._maxRestRetryDelay
            );

            logger.warn(`[${this.strategyId}] ⚠️ REST retry ${this._restRetryCount}, delay: ${this._restRetryDelay}ms`);
            this.updateSyncStatus('ERROR');
            this._syncStatus.lastError = e.message;

            if (this._restRetryDelay >= this._maxRestRetryDelay) {
                await this.emergencyStopAndCancelAll(brokerAdapter);
            }

        } finally {
            this._restSyncInProgress = false;
        }
    }

    // ============================================================
    // ЭКСТРЕННАЯ ОСТАНОВКА
    // ============================================================
    async emergencyStopAndCancelAll(brokerAdapter) {
        if (this._emergencyStopTriggered) return;
        this._emergencyStopTriggered = true;

        logger.err(`[${this.strategyId}] 🚨🚨🚨 EMERGENCY STOP - CANCELING ALL ORDERS 🚨🚨🚨`);
        logger.err(`[${this.strategyId}] Reason: REST fallback timeout exceeded (${this._restRetryDelay}ms)`);

        try {
            const activeOrders = this.getActiveOrders();

            if (activeOrders.length === 0) {
                logger.info(`[${this.strategyId}] No active orders to cancel`);
            } else {
                logger.info(`[${this.strategyId}] Cancelling ${activeOrders.length} orders...`);

                for (const order of activeOrders) {
                    try {
                        const brokerOrderId = order.brokerOrderId || order.orderId;
                        if (brokerOrderId && brokerOrderId !== order.clientOrderId) {
                            await brokerAdapter.cancelOrder({ orderId: brokerOrderId });
                            logger.info(`[${this.strategyId}] ✅ Cancelled order: ${order.clientOrderId}`);
                        }
                    } catch (e) {
                        logger.err(`[${this.strategyId}] ❌ Failed to cancel order ${order.clientOrderId}: ${e.message}`);
                    }
                }
            }

            this.orders.clear();
            this.pendingConfirmations.clear();

            if (this.useDb) {
                await db.query('DELETE FROM orders WHERE strategy_id = $1', [this.strategyId]);
                logger.info(`[${this.strategyId}] Cleared all orders from DB`);
            }

            this._syncStatus.status = 'EMERGENCY_STOP';
            this.emit('emergency_stop_triggered', {
                strategyId: this.strategyId,
                reason: 'REST fallback timeout',
                timestamp: new Date()
            });

            logger.err(`[${this.strategyId}] 🛑 Emergency stop complete - all orders cancelled`);

        } catch (e) {
            logger.err(`[${this.strategyId}] ❌ Emergency stop failed: ${e.message}`);
        }
    }

    // ============================================================
    // ПРОВЕРКА СТАТУСА СИНХРОНИЗАЦИИ
    // ============================================================
    isSynced() {
        const connectionOk = this._wsConnected || this._restFallbackActive;
        const noPending = this.pendingConfirmations.size === 0;
        const statusOk = this._syncStatus.status !== 'ERROR' &&
            this._syncStatus.status !== 'EMERGENCY_STOP';
        return connectionOk && noPending && statusOk;
    }

    canOperate() {
        const wsOk = this._wsConnected;
        const restOk = this._restFallbackActive && this._restRetryDelay < this._maxRestRetryDelay;
        const connectionOk = wsOk || restOk;
        const noPending = this.pendingConfirmations.size === 0;
        const statusOk = this._syncStatus.status === 'SYNCED' || this._syncStatus.status === 'SYNCING';
        return connectionOk && noPending && statusOk;
    }

    updateSyncStatus(status) {
        this._syncStatus.status = status;
        this._syncStatus.lastUpdate = new Date();
        this._syncStatus.stackCount = this.orders.size;
        this._syncStatus.pendingCount = this.pendingConfirmations.size;
        this._syncStatus.wsConnected = this._wsConnected;
        this._syncStatus.restFallback = this._restFallbackActive;
        this._syncStatus.canOperate = this.canOperate();
        this._syncStatus.isSynced = this.isSynced();
        this._syncStatus.restRetryCount = this._restRetryCount;
        this._syncStatus.restRetryDelay = this._restRetryDelay;
        this.emit('sync_status_changed', {
            strategyId: this.strategyId,
            status: this._syncStatus,
            timestamp: new Date()
        });
    }

    getSyncStatus() {
        return {
            ...this._syncStatus,
            wsConnected: this._wsConnected,
            restFallback: this._restFallbackActive,
            restRetryCount: this._restRetryCount,
            restRetryDelay: this._restRetryDelay,
            pendingCount: this.pendingConfirmations.size,
            canOperate: this.canOperate(),
            isSynced: this.isSynced()
        };
    }

    // ============================================================
    // WS СОБЫТИЯ
    // ============================================================
    syncWithWs(event) {
        this._wsLastPongTime = Date.now();

        if (!this._wsConnected) {
            this._wsConnected = true;
            this._restFallbackActive = false;
            this._restRetryCount = 0;
            this._restRetryDelay = 2000;
            this._syncStatus.wsConnected = true;
            this._syncStatus.restFallback = false;
            this.updateSyncStatus('SYNCED');
            this.emit('ws_reconnected', {
                strategyId: this.strategyId,
                timestamp: new Date()
            });
            logger.ok(`[${this.strategyId}] ✅ WS connection restored via message`);
        }

        const { clientOrderId, status } = event;
        if (!clientOrderId) {
            logger.warn(`[${this.strategyId}] WS event without clientOrderId`);
            return;
        }

        logger.debug(`[${this.strategyId}] 📨 WS event: ${clientOrderId} status=${status}`);
        const brokerOrderId = event?.orderId || event?.data?.orderId || null;
        const price = event?.price || event?.data?.price || null;
        const quantity = event?.quantity || event?.data?.orderQuantity || null;
        const filledQuantity = event?.filledQuantity || event?.data?.executedQuantity || null;

        if (status === '9' || status === 'REPLACING') {
            logger.info(`[${this.strategyId}] 🔄 Order ${clientOrderId} is REPLACING - old order`);
            if (this.orders.has(clientOrderId)) {
                const order = this.orders.get(clientOrderId);
                order.status = 'REPLACING';
                order.isActive = false;
                order.lastUpdate = new Date();
                order.wsConfirmed = true;
                this.addToHistory(order);
                this.orders.delete(clientOrderId);
                this.deleteOrderFromDb(clientOrderId);
                this.emit('order_replaced', { oldOrderId: clientOrderId, order });
            }
            if (this.pendingConfirmations.has(clientOrderId)) {
                this.pendingConfirmations.delete(clientOrderId);
                this._pendingSyncOrders.delete(clientOrderId);
            }
            this.markWsSynced();
            this.updateSyncStatus('SYNCED');
            return;
        }

        if (status === '5' || status === 'REPLACED') {
            logger.info(`[${this.strategyId}] 📌 Order ${clientOrderId} is REPLACED - new active order`);
            const oldOrderId = event.originalClientOrderId || event.data?.originalClientOrderId || null;
            if (oldOrderId) {
                if (this.orders.has(oldOrderId)) {
                    const oldOrder = this.orders.get(oldOrderId);
                    oldOrder.status = 'REPLACING';
                    oldOrder.replacedBy = clientOrderId;
                    oldOrder.isActive = false;
                    oldOrder.lastUpdate = new Date();
                    oldOrder.wsConfirmed = true;
                    this.addToHistory(oldOrder);
                    this.orders.delete(oldOrderId);
                    this.deleteOrderFromDb(oldOrderId);
                    logger.info(`[${this.strategyId}] ✅ Removed old order: ${oldOrderId} → ${clientOrderId}`);
                }
                if (this.pendingConfirmations.has(oldOrderId)) {
                    this.pendingConfirmations.delete(oldOrderId);
                    this._pendingSyncOrders.delete(oldOrderId);
                }
            }
            if (this.pendingConfirmations.has(clientOrderId)) {
                const pending = this.pendingConfirmations.get(clientOrderId);
                if (brokerOrderId) {
                    pending.order.brokerOrderId = brokerOrderId;
                    pending.order.orderId = brokerOrderId;
                }
                if (price) pending.order.price = price;
                if (quantity) pending.order.quantity = quantity;
                if (filledQuantity) pending.order.filledQuantity = filledQuantity;
                pending.order.status = status;
                pending.order.wsConfirmed = true;
                this.confirm(clientOrderId, status, event);
            } else {
                logger.warn(`[${this.strategyId}] Unknown REPLACED order from WS: ${clientOrderId}`);
                this.emit('unknown_order', event);
            }
            this.markWsSynced();
            this.updateSyncStatus('SYNCED');
            return;
        }

        if (this.pendingConfirmations.has(clientOrderId)) {
            const pending = this.pendingConfirmations.get(clientOrderId);
            const pendingOrder = pending.order;

            if (pendingOrder.status === 'PENDING_CANCEL') {
                const originalOrderId = pendingOrder.originalOrderId;
                if (originalOrderId && this.orders.has(originalOrderId)) {
                    const originalOrder = this.orders.get(originalOrderId);
                    originalOrder.status = status || 'CANCELLED';
                    originalOrder.cancelledAt = new Date();
                    originalOrder.responseData = event;
                    originalOrder.wsConfirmed = true;
                    this.addToHistory(originalOrder);
                    this.orders.delete(originalOrderId);
                    this.deleteOrderFromDb(originalOrderId);
                    logger.ok(`[${this.strategyId}] ✅ Order ${originalOrderId} cancelled via WS`);
                    this.emit('order_cancelled', originalOrder);
                }
                this.pendingConfirmations.delete(clientOrderId);
                this._pendingSyncOrders.delete(clientOrderId);
                this.markWsSynced();
                this.updateSyncStatus('SYNCED');
                return;
            }

            if (status === 'ERROR' || status === '8' || status === 'REJECTED' || status === '7') {
                const order = pending.order;
                logger.err(`[${this.strategyId}] ❌ Order ${clientOrderId} failed with ${status}`);
                order.status = status;
                order.error = event;
                order.lastUpdate = new Date();
                order.attempts = (order.attempts || 0) + 1;
                order.wsConfirmed = true;
                if (brokerOrderId) {
                    order.brokerOrderId = brokerOrderId;
                    order.orderId = brokerOrderId;
                }
                if (!this.orders.has(clientOrderId)) {
                    this.orders.set(clientOrderId, order);
                    this.saveOrderToDb(order);
                }
                this.pendingConfirmations.delete(clientOrderId);
                this._pendingSyncOrders.delete(clientOrderId);
                this.markWsSynced();
                this.updateSyncStatus('ERROR');
                if (order.attempts >= 3) {
                    this.emergencyStopStrategy(`Order ${clientOrderId} failed after ${order.attempts} attempts`, {
                        order: {
                            clientOrderId: order.clientOrderId,
                            price: order.price,
                            quantity: order.quantity,
                            status: order.status,
                            attempts: order.attempts,
                            createdAt: order.createdAt
                        },
                        lastEvent: event,
                        stackSize: this.orders.size,
                        pendingSize: this.pendingConfirmations.size
                    });
                    return;
                }
                this.emit('order_error', { clientOrderId, event, order });
                return;
            }

            if (this.isReplacedStatus(status)) {
                const replacesOrderId = pendingOrder.replaces || pendingOrder.originalOrderId;
                if (replacesOrderId && this.orders.has(replacesOrderId)) {
                    const oldOrder = this.orders.get(replacesOrderId);
                    oldOrder.status = 'REPLACED';
                    oldOrder.replacedBy = clientOrderId;
                    if (brokerOrderId) {
                        oldOrder.brokerOrderId = brokerOrderId;
                        oldOrder.orderId = brokerOrderId;
                    }
                    oldOrder.lastUpdate = new Date();
                    oldOrder.wsConfirmed = true;
                    this.addToHistory(oldOrder);
                    this.orders.delete(replacesOrderId);
                    this.deleteOrderFromDb(replacesOrderId);
                }
            }

            if (brokerOrderId) {
                pendingOrder.brokerOrderId = brokerOrderId;
                pendingOrder.orderId = brokerOrderId;
            }
            if (price) pendingOrder.price = price;
            if (quantity) pendingOrder.quantity = quantity;
            if (filledQuantity) pendingOrder.filledQuantity = filledQuantity;
            this.confirm(clientOrderId, status, event);
            this.markWsSynced();
            this.updateSyncStatus('SYNCED');
            return;
        }

        if (this.orders.has(clientOrderId)) {
            this.updateOrder(clientOrderId, event);
            this.markWsSynced();
            this.updateSyncStatus('SYNCED');
            return;
        }

        if (this.isFinalStatus(status)) {
            logger.debug(`[${this.strategyId}] Unknown closed order from WS: ${clientOrderId} (${status})`);
        } else {
            logger.warn(`[${this.strategyId}] ⚠️ Unknown order from WS: ${clientOrderId} (${status})`);
            this.emit('unknown_order', event);
        }
    }

    // ============================================================
    // ЗАГРУЗКА ИЗ БД
    // ============================================================
    async loadOrdersFromDb() {
        if (!this.useDb) return [];
        try {
            const result = await db.query(
                'SELECT * FROM orders WHERE strategy_id = $1 AND is_active = true',
                [this.strategyId]
            );
            return result.rows || [];
        } catch (e) {
            logger.err(`[${this.strategyId}] Failed to load orders from DB: ${e.message}`);
            return [];
        }
    }

    async initialize(brokerAdapter) {
        if (this._initialized) return;
        logger.info(`[${this.strategyId}] Initializing order stack from DB...`);

        try {
            this._brokerAdapter = brokerAdapter;

            const dbOrders = await this.loadOrdersFromDb();
            this.orders.clear();

            for (const dbOrder of dbOrders) {
                const order = {
                    clientOrderId: dbOrder.client_order_id,
                    brokerOrderId: dbOrder.broker_order_id,
                    strategyId: this.strategyId,
                    price: dbOrder.price,
                    quantity: dbOrder.quantity,
                    filledQuantity: dbOrder.filled_quantity || 0,
                    remainingQuantity: dbOrder.remaining_quantity || dbOrder.quantity,
                    status: dbOrder.status,
                    side: dbOrder.side || 'BUY',
                    role: dbOrder.role || null,
                    metadata: dbOrder.metadata || {},
                    createdAt: dbOrder.created_at,
                    updatedAt: dbOrder.updated_at,
                    isActive: true,
                    wsConfirmed: true,
                    restConfirmed: true,
                };
                this.orders.set(dbOrder.client_order_id, order);
                logger.info(`[${this.strategyId}] Loaded from DB: ${order.clientOrderId} (status: ${order.status})`);
            }

            this._initialized = true;
            this._isWsSynced = true;
            this._lastWsSyncTime = Date.now();
            this._wsLastPongTime = Date.now();
            this._wsConnected = true;
            logger.ok(`[${this.strategyId}] Loaded ${this.orders.size} orders from DB`);

            this.startCleanup();

        } catch (e) {
            logger.err(`[${this.strategyId}] Failed to initialize: ${e.message}`);
            throw e;
        }
    }

    // ============================================================
    // СОХРАНЕНИЕ/УДАЛЕНИЕ В БД
    // ============================================================
    async saveOrderToDb(order) {
        if (!this.useDb) return;
        try {
            const orderData = {
                clientOrderId: order.clientOrderId,
                brokerOrderId: order.brokerOrderId || null,
                strategyId: this.strategyId,
                instrumentId: null,
                side: order.side || 'BUY',
                orderType: order.orderType || 'LIMIT',
                price: order.price || 0,
                quantity: order.quantity || 1,
                filledQuantity: order.filledQuantity || 0,
                remainingQuantity: order.remainingQuantity || order.quantity || 1,
                status: order.status || 'PENDING',
                brokerStatus: order.orderStatus || null,
                role: order.role || null,
                metadata: order.metadata || {},
                isActive: true,
                isWsConfirmed: order.wsConfirmed || false,
                isRestConfirmed: order.restConfirmed || false,
            };
            await db.query(`
                INSERT INTO orders (
                    client_order_id, broker_order_id, strategy_id, instrument_id,
                    side, order_type, price, quantity, filled_quantity, remaining_quantity,
                    status, broker_status, role, metadata, raw_broker_response,
                    broker_order_number, broker_client_code, broker_execution_id,
                    broker_transaction_time, is_active, is_ws_confirmed, is_rest_confirmed
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
                ON CONFLICT (client_order_id) DO UPDATE SET
                    broker_order_id = EXCLUDED.broker_order_id,
                    status = EXCLUDED.status,
                    broker_status = EXCLUDED.broker_status,
                    updated_at = CURRENT_TIMESTAMP,
                    version = orders.version + 1,
                    filled_quantity = EXCLUDED.filled_quantity,
                    remaining_quantity = EXCLUDED.remaining_quantity,
                    is_active = EXCLUDED.is_active,
                    strategy_id = EXCLUDED.strategy_id,
                    price = EXCLUDED.price
            `, [
                orderData.clientOrderId,
                orderData.brokerOrderId,
                orderData.strategyId,
                orderData.instrumentId,
                orderData.side,
                orderData.orderType || 'LIMIT',
                orderData.price,
                orderData.quantity,
                orderData.filledQuantity || 0,
                orderData.remainingQuantity || orderData.quantity,
                orderData.status || 'PENDING',
                orderData.brokerStatus,
                orderData.role,
                orderData.metadata || {},
                orderData.rawBrokerResponse,
                orderData.brokerOrderNumber,
                orderData.brokerClientCode,
                orderData.brokerExecutionId,
                orderData.brokerTransactionTime,
                orderData.isActive !== false,
                orderData.isWsConfirmed || false,
                orderData.isRestConfirmed || false,
            ]);
            logger.debug(`[${this.strategyId}] Saved to DB: ${order.clientOrderId}`);
        } catch (e) {
            logger.err(`[${this.strategyId}] Failed to save to DB: ${e.message}`);
        }
    }

    async deleteOrderFromDb(clientOrderId) {
        if (!this.useDb) return;
        try {
            await db.query('DELETE FROM orders WHERE client_order_id = $1', [clientOrderId]);
            logger.debug(`[${this.strategyId}] Deleted from DB: ${clientOrderId}`);
        } catch (e) {
            logger.err(`[${this.strategyId}] Failed to delete from DB: ${e.message}`);
        }
    }

    // ============================================================
    // ПОЛУЧЕНИЕ ЗАЯВОК
    // ============================================================
    isFinalStatus(status) {
        const finalStatuses = ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED', '2', '4', '7', '9'];
        return finalStatuses.includes(String(status));
    }

    isActiveStatus(status) {
        const activeStatuses = ['CREATED', 'MODIFIED', 'PARTIALLY_FILLED', 'PENDING', 'ACTIVE', '0', '1', '3', '5'];
        return activeStatuses.includes(String(status));
    }

    isReplacedStatus(status) {
        const replacedStatuses = ['REPLACED', '5'];
        return replacedStatuses.includes(String(status));
    }

    getValidActiveOrders() {
        const result = [];
        for (const [id, order] of this.orders) {
            if (String(order.status) === '9' || String(order.status) === 'REPLACING') continue;
            if (this.isActiveStatus(order.status)) {
                result.push(order);
            }
        }
        return result;
    }

    getActiveOrders() {
        const result = [];
        for (const [id, order] of this.orders) {
            if (String(order.status) === '9' || String(order.status) === 'REPLACING') continue;
            if (this.isActiveStatus(order.status) || order.status === 'ERROR' || order.status === 'REJECTED') {
                result.push(order);
            }
        }
        return result;
    }

    getOrder(clientOrderId) {
        return this.orders.get(clientOrderId) || null;
    }

    getLatestOrder() {
        const active = this.getActiveOrders();
        if (active.length === 0) return null;
        active.sort((a, b) => b.createdAt - a.createdAt);
        return active[0];
    }

    hasActiveOrders() {
        return this.getActiveOrders().length > 0;
    }

    getActiveCount() {
        return this.getActiveOrders().length;
    }

    getHistory(limit = 50) {
        return this.history.slice(-limit);
    }

    // ============================================================
    // PENDING И ПОДТВЕРЖДЕНИЯ
    // ============================================================
    addPending(order) {
        if (this.orders.has(order.clientOrderId)) {
            logger.warn(`[${this.strategyId}] Order ${order.clientOrderId} already exists, updating`);
            this.orders.delete(order.clientOrderId);
        }

        this.pendingConfirmations.set(order.clientOrderId, {
            order,
            timestamp: Date.now(),
            attempts: 0,
            replacesOrderId: order.replaces || null,
            brokerOrderId: order.brokerOrderId || null,
        });

        this.markWsUnsynced(order.clientOrderId, 'PENDING');
        logger.info(`[${this.strategyId}] 📌 Order ${order.clientOrderId} pending confirmation`);
        this.emit('pending_added', order);

        setTimeout(() => {
            if (this.pendingConfirmations.has(order.clientOrderId)) {
                const pending = this.pendingConfirmations.get(order.clientOrderId);
                if (Date.now() - pending.timestamp > this.pendingTimeout) {
                    logger.warn(`[${this.strategyId}] ⏰ Pending timeout for ${order.clientOrderId}`);
                    this.pendingConfirmations.delete(order.clientOrderId);
                    this._pendingSyncOrders.delete(order.clientOrderId);
                    this.emit('pending_timeout', order);
                    this.deleteOrderFromDb(order.clientOrderId);
                }
            }
        }, this.pendingTimeout);
    }

    confirm(clientOrderId, status, data = null) {
        const pending = this.pendingConfirmations.get(clientOrderId);
        if (!pending) {
            logger.warn(`[${this.strategyId}] Confirmation for unknown order: ${clientOrderId}`);
            return false;
        }

        const order = pending.order;
        order.status = status;
        order.confirmedAt = new Date();
        order.responseData = data;
        order.wsConfirmed = true;
        order.lastUpdate = new Date();

        let brokerOrderId = data?.orderId || data?.data?.orderId || order.brokerOrderId || null;
        if (brokerOrderId) {
            order.brokerOrderId = brokerOrderId;
            order.orderId = brokerOrderId;
        }

        this._pendingWsConfirmations.set(clientOrderId, {
            confirmed: true,
            status: status,
            timestamp: Date.now()
        });

        const isFinal = this.isFinalStatus(status);
        const isReplaced = status === '5' || status === 'REPLACED';

        if (isReplaced) {
            const oldOrderId = order.replaces || order.originalOrderId || null;
            if (oldOrderId && this.orders.has(oldOrderId)) {
                const oldOrder = this.orders.get(oldOrderId);
                oldOrder.status = 'REPLACING';
                oldOrder.replacedBy = clientOrderId;
                oldOrder.isActive = false;
                oldOrder.lastUpdate = new Date();
                oldOrder.wsConfirmed = true;
                this.addToHistory(oldOrder);
                this.orders.delete(oldOrderId);
                this.deleteOrderFromDb(oldOrderId);
                logger.info(`[${this.strategyId}] Removed old order: ${oldOrderId} → ${clientOrderId}`);
            }
            if (oldOrderId && this.pendingConfirmations.has(oldOrderId)) {
                this.pendingConfirmations.delete(oldOrderId);
                this._pendingSyncOrders.delete(oldOrderId);
            }
        }

        if (isFinal && !isReplaced) {
            this.orders.delete(clientOrderId);
            this.addToHistory(order);
            this.deleteOrderFromDb(clientOrderId);
            logger.ok(`[${this.strategyId}] ✅ Order ${clientOrderId} closed: ${status}`);
            this.emit('order_closed', order);
        } else {
            this.orders.set(clientOrderId, order);
            this.saveOrderToDb(order);
            logger.ok(`[${this.strategyId}] ✅ Order ${clientOrderId} confirmed: ${status}`);
            this.emit('order_confirmed', order);
        }

        this.pendingConfirmations.delete(clientOrderId);
        this._pendingSyncOrders.delete(clientOrderId);
        this.markWsSynced();
        this.updateSyncStatus('SYNCED');
        return true;
    }

    updateOrder(clientOrderId, event) {
        const order = this.orders.get(clientOrderId);
        if (!order) return;

        const oldStatus = order.status;
        const newStatus = event.status || order.status;

        if (oldStatus !== newStatus) {
            logger.info(`[${this.strategyId}] Order ${clientOrderId} status: ${oldStatus} → ${newStatus}`);
        }

        order.status = newStatus;
        order.lastUpdate = new Date();

        if (event.price) order.price = event.price;
        if (event.quantity) order.quantity = event.quantity;
        if (event.filledQuantity) {
            order.filledQuantity = (order.filledQuantity || 0) + event.filledQuantity;
            order.remainingQuantity = order.quantity - order.filledQuantity;
        }

        const brokerOrderId = event?.orderId || event?.data?.orderId || null;
        if (brokerOrderId) {
            order.brokerOrderId = brokerOrderId;
            order.orderId = brokerOrderId;
        }

        if (order.remainingQuantity <= 0 && order.status === 'FILLED') {
            this.orders.delete(clientOrderId);
            this.addToHistory(order);
            this.deleteOrderFromDb(clientOrderId);
            this.emit('order_filled', order);
            return;
        }

        if (['CANCELLED', 'EXPIRED'].includes(order.status)) {
            this.orders.delete(clientOrderId);
            this.addToHistory(order);
            this.deleteOrderFromDb(clientOrderId);
            this.emit('order_closed', order);
            return;
        }

        if (['ERROR', 'REJECTED'].includes(order.status)) {
            order.attempts = (order.attempts || 0) + 1;
            if (order.attempts >= 3) {
                this.emergencyStopStrategy(`Order ${clientOrderId} failed after ${order.attempts} attempts`, {
                    order: {
                        clientOrderId: order.clientOrderId,
                        price: order.price,
                        quantity: order.quantity,
                        status: order.status,
                        attempts: order.attempts,
                        createdAt: order.createdAt
                    },
                    lastEvent: event,
                    stackSize: this.orders.size,
                    pendingSize: this.pendingConfirmations.size
                });
                return;
            }
            this.emit('order_invalid', { clientOrderId, status: order.status, attempts: order.attempts });
            return;
        }

        this.saveOrderToDb(order);
        this.emit('order_updated', order);
    }

    // ============================================================
    // МОДИФИКАЦИЯ ЗАЯВОК
    // ============================================================
    canModifyOrder(clientOrderId) {
        const order = this.orders.get(clientOrderId);
        if (!order) return false;
        if (this.isPending(clientOrderId)) return false;
        const cannotModifyStatuses = ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED', '2', '4', '7', '9'];
        if (cannotModifyStatuses.includes(String(order.status))) return false;
        if (['ERROR', 'REJECTED'].includes(order.status) && (order.attempts || 0) >= 3) return false;
        if (!order.brokerOrderId || order.brokerOrderId === order.clientOrderId) return false;
        return true;
    }

    getOrderForModify(clientOrderId) {
        if (!this.canModifyOrder(clientOrderId)) return null;
        return this.orders.get(clientOrderId);
    }

    // ============================================================
    // АВАРИЙНАЯ ОСТАНОВКА
    // ============================================================
    emergencyStopStrategy(reason, context) {
        logger.err(`[${this.strategyId}] 🚨 EMERGENCY STOP: ${reason}`);
        this.emit('emergency_stop', {
            strategyId: this.strategyId,
            reason,
            context,
            timestamp: new Date().toISOString()
        });
        this._initialized = false;
        this.stopCleanup();
        this.stopPingPong();
    }

    // ============================================================
    // ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ
    // ============================================================
    markWsSynced() {
        this._isWsSynced = true;
        this._lastWsSyncTime = Date.now();
    }

    markWsUnsynced(orderId, action) {
        this._isWsSynced = false;
        this._pendingSyncOrders.set(orderId, {
            action,
            timestamp: Date.now(),
            attempts: 0
        });
    }

    isPending(clientOrderId) {
        return this.pendingConfirmations.has(clientOrderId);
    }

    getPendingOrders() {
        return Array.from(this.pendingConfirmations.values()).map(p => p.order);
    }

    // ============================================================
    // ОЧИСТКА
    // ============================================================
    startCleanup() {
        if (this._cleanupTimer) clearInterval(this._cleanupTimer);
        this._cleanupTimer = setInterval(() => {
            this.cleanStalePending();
        }, 10000);
        logger.info(`[${this.strategyId}] Cleanup started (interval: 10s)`);
    }

    stopCleanup() {
        if (this._cleanupTimer) {
            clearInterval(this._cleanupTimer);
            this._cleanupTimer = null;
        }
    }

    cleanStalePending() {
        const now = Date.now();
        const cleaned = [];
        for (const [id, pending] of this.pendingConfirmations) {
            if (now - pending.timestamp > this.pendingTimeout) {
                cleaned.push(id);
            }
        }
        for (const id of cleaned) {
            this.pendingConfirmations.delete(id);
            this._pendingSyncOrders.delete(id);
            logger.warn(`[${this.strategyId}] Removed stale pending: ${id}`);
            this.deleteOrderFromDb(id);
        }
        if (cleaned.length > 0) {
            this.emit('stale_cleaned', cleaned);
            this.updateSyncStatus('SYNCED');
        }
        return cleaned;
    }

    // ============================================================
    // ИСТОРИЯ
    // ============================================================
    addToHistory(order) {
        this.history.push({ ...order, archivedAt: new Date() });
        if (this.history.length > this.maxHistorySize) {
            this.history.shift();
        }
    }

    // ============================================================
    // СБРОС
    // ============================================================
    reset() {
        this.orders.clear();
        this.pendingConfirmations.clear();
        this._pendingSyncOrders.clear();
        this._pendingWsConfirmations.clear();
        this.stopCleanup();
        this.stopPingPong();
        this._initialized = false;
        this._isWsSynced = true;
        this._wsConnected = true;
        this._restFallbackActive = false;
        this._emergencyStopTriggered = false;
        this._syncStatus.status = 'SYNCED';
    }

    // ============================================================
    // СТАТИСТИКА
    // ============================================================
    getStats() {
        return {
            strategyId: this.strategyId,
            activeCount: this.getActiveCount(),
            validActiveCount: this.getValidActiveOrders().length,
            pendingCount: this.pendingConfirmations.size,
            historyCount: this.history.length,
            initialized: this._initialized,
            isWsSynced: this._isWsSynced,
            syncStatus: this._syncStatus,
            wsConnected: this._wsConnected,
            restFallback: this._restFallbackActive,
            canOperate: this.canOperate(),
            activeOrders: this.getActiveOrders().map(o => ({
                clientOrderId: o.clientOrderId,
                status: o.status,
                price: o.price,
                quantity: o.quantity,
                filledQuantity: o.filledQuantity || 0,
                attempts: o.attempts || 0,
                brokerOrderId: o.brokerOrderId || null,
            })),
        };
    }
}

module.exports = OrderStack;