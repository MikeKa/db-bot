const WebSocket = require('ws');
const config = require('../config');
const auth = require('./auth');
const logger = require('../utils/logger');
const EventEmitter = require('events');

class ExecutionReportProvider extends EventEmitter {
    constructor() {
        super();
        this.ws = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 20;
        this.messageCount = 0;
        this.transactions = new Map();
        this._reconnectTimer = null;
        this._orderStack = null;
        this._isReconnecting = false;
        this._reconnectDelay = 2000;
        this._maxReconnectDelay = 30000;
        this._jitterRange = 500;
    }

    setOrderStack(orderStack) {
        this._orderStack = orderStack;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            if (this._orderStack) {
                this._orderStack._wsLastPongTime = Date.now();
            }
        }
    }

    async connect() {
        try {
            const token = await auth.getAccessToken();
            return new Promise((resolve, reject) => {
                try {
                    if (this.ws) {
                        try {
                            this.ws.removeAllListeners();
                            this.ws.close();
                        } catch (e) { }
                        this.ws = null;
                    }

                    const wsUrl = config.wsTransactionsUrl;

                    logger.info(`[TX WS] Connecting to ${wsUrl}`);

                    this.ws = new WebSocket(wsUrl, {
                        headers: { 'Authorization': `Bearer ${token}` }
                    });

                    const connectTimeout = setTimeout(() => {
                        if (!this.isConnected) {
                            this.ws.close();
                            reject(new Error('Connection timeout'));
                        }
                    }, 10000);

                    this.ws.on('open', () => {
                        clearTimeout(connectTimeout);
                        this.isConnected = true;
                        this.reconnectAttempts = 0;
                        this._isReconnecting = false;

                        if (this._orderStack) {
                            this._orderStack._wsLastPongTime = Date.now();
                        }

                        logger.ok('✅ Transactions WebSocket Connected');
                        resolve();
                    });

                    this.ws.on('message', (data) => {
                        if (this._orderStack) {
                            this._orderStack._wsLastPongTime = Date.now();
                        }
                        this.handleMessage(data);
                    });

                    this.ws.on('ping', () => {
                        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                            this.ws.pong();
                            if (this._orderStack) {
                                this._orderStack._wsLastPongTime = Date.now();
                            }
                        }
                    });

                    this.ws.on('pong', () => {
                        if (this._orderStack) {
                            this._orderStack._wsLastPongTime = Date.now();
                        }
                    });

                    this.ws.on('error', (error) => {
                        logger.wsLog(`❌ Transactions WS Error: ${error.message}`);
                        if (!this.isConnected) {
                            clearTimeout(connectTimeout);
                            reject(error);
                        }
                    });

                    this.ws.on('close', (code, reason) => {
                        clearTimeout(connectTimeout);
                        this.isConnected = false;

                        if (this._orderStack) {
                            this._orderStack._wsConnected = false;
                            this._orderStack._syncStatus.wsConnected = false;
                            this._orderStack.updateSyncStatus('ERROR');
                        }

                        logger.wsLog(`⚠️ Transactions WS Disconnected (code: ${code})`);
                        this.emit('disconnected');
                        this.reconnect();
                    });

                } catch (e) {
                    reject(e);
                }
            });
        } catch (e) {
            logger.err(`❌ Transactions WS Connection failed: ${e.message}`);
            throw e;
        }
    }

    handleMessage(data) {
        try {
            const payload = JSON.parse(data.toString());
            this.messageCount++;

            const clientOrderId = payload.clientOrderId || payload.originalClientOrderId || null;
            const orderId = payload.orderId || payload.data?.orderId || null;

            if (clientOrderId) {
                this.transactions.set(clientOrderId, {
                    ...payload,
                    timestamp: new Date(),
                    raw: payload
                });
            }

            const orderStatus = payload.data?.orderStatus || payload.status;
            const statusMap = {
                '0': 'orderCreated',
                '1': 'orderPartial',
                '2': 'orderFilled',
                '4': 'orderCancelled',
                '5': 'orderModified',
                '6': 'orderCancelling',
                '8': 'orderError',
                '9': 'orderModifying'
            };

            let eventName = statusMap[orderStatus] || 'orderUpdate';

            const eventData = {
                clientOrderId: clientOrderId,
                orderId: orderId,
                status: orderStatus,
                price: payload.data?.price || payload.price || 0,
                quantity: payload.data?.orderQuantity || payload.quantity || 0,
                filledQuantity: payload.data?.executedQuantity || payload.filledQuantity || 0,
                remainingQuantity: payload.data?.remainedQuantity || payload.remainingQuantity || 0,
                raw: payload,
                originalClientOrderId: payload.originalClientOrderId || null,
                data: payload.data || payload
            };

            this.emit(eventName, eventData);

            if (['orderCreated', 'orderModified', 'orderFilled', 'orderCancelled', 'orderError'].includes(eventName)) {
                logger.wsLog(`📨 ${eventName}: ${clientOrderId} (status: ${orderStatus})`);
            }

        } catch (e) {
            logger.wsLog(`❌ Transactions WS Parse error: ${e.message}`);
        }
    }

    getTransaction(orderId) {
        return this.transactions.get(orderId) || null;
    }

    // ============================================================
    // РАЗДЕЛЬНЫЙ RECONNECT С JITTER (0-500ms)
    // ============================================================
    reconnect() {
        if (this._isReconnecting) {
            logger.debug('[TX WS] Already reconnecting, skipping...');
            return;
        }

        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            logger.wsLog('❌ Max reconnect attempts reached');
            return;
        }

        this._isReconnecting = true;
        this.reconnectAttempts++;

        let delay = this._reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1);
        delay = Math.min(delay, this._maxReconnectDelay);

        // Jitter 0-500ms для разделения переподключений
        const jitter = Math.random() * this._jitterRange;
        const totalDelay = delay + jitter;

        logger.wsLog(`🔄 Transactions WS reconnecting in ${(totalDelay / 1000).toFixed(2)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        this._reconnectTimer = setTimeout(async () => {
            try {
                await this.connect();
                this.reconnectAttempts = 0;
                this._isReconnecting = false;
                logger.ok('✅ Transactions WS reconnected successfully');
            } catch (e) {
                logger.wsLog(`❌ Reconnect failed: ${e.message}`);
                this._isReconnecting = false;
                this.reconnect();
            }
        }, totalDelay);
    }

    disconnect() {
        this._isReconnecting = false;

        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }

        if (this.ws) {
            try { this.ws.close(); } catch (e) { }
            this.ws = null;
        }

        this.isConnected = false;

        if (this._orderStack) {
            this._orderStack._wsConnected = false;
            this._orderStack._syncStatus.wsConnected = false;
            this._orderStack.updateSyncStatus('ERROR');
        }

        logger.wsLog('🔌 Transactions WS Disconnected');
    }

    getStats() {
        return {
            isConnected: this.isConnected,
            messageCount: this.messageCount,
            transactionsCount: this.transactions.size,
            reconnectAttempts: this.reconnectAttempts,
            isReconnecting: this._isReconnecting
        };
    }

    // Добавляем метод для принудительного закрытия
    forceClose() {
        this._isReconnecting = false;
        this.stopHeartbeat();

        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }

        if (this.ws) {
            try {
                this.ws.removeAllListeners();
                this.ws.close(1000, 'Force close');
            } catch (e) { }
            this.ws = null;
        }

        this.isConnected = false;
        logger.wsLog('🔌 Transactions WS force closed');
    }
}

module.exports = new ExecutionReportProvider();