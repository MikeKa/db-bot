const EventEmitter = require('events');
const logger = require('../../utils/logger');
const { ExecutionResult } = require('../interfaces');

class ExecutionEngine extends EventEmitter {
    constructor(options = {}) {
        super();
        this.brokerAdapter = null;
        this.orderManager = null;
        this.executionQueue = null;
        this.timeout = options.timeout || 5000;
        this.maxRetries = options.maxRetries || 3;
        this.retryDelay = options.retryDelay || 1000;
        this.confirmationTimeout = options.confirmationTimeout || 3000;
        this.stats = { total: 0, successful: 0, failed: 0, retries: 0, timeouts: 0, wsConfirmed: 0, restConfirmed: 0, blocked: 0 };
        this._pendingRequests = new Map();
        this._isShuttingDown = false;
    }

    setBrokerAdapter(adapter) { this.brokerAdapter = adapter; }
    setOrderManager(manager) { this.orderManager = manager; }
    setExecutionQueue(queue) { this.executionQueue = queue; queue.executeRequest = this.executeRequest.bind(this); }

    start() {
        if (!this.brokerAdapter) throw new Error('BrokerAdapter not set');
        if (!this.executionQueue) throw new Error('ExecutionQueue not set');
        logger.info('[Engine] Starting execution engine...');
        logger.info(`[Engine] WS timeout: ${this.confirmationTimeout}ms, Max retries: ${this.maxRetries}`);
        this.executionQueue.processNext();
    }

    async executeRequest(request) {
        if (this._isShuttingDown) throw new Error('Engine is shutting down');

        // Проверяем только критические ошибки, не блокируем при pending
        if (this.orderManager) {
            const stack = this.orderManager.getStack(request.strategyId);
            if (stack) {
                const syncStatus = stack.getSyncStatus();
                // Блокируем только при критических ошибках
                if (syncStatus.status === 'ERROR' || syncStatus.status === 'EMERGENCY_STOP') {
                    logger.err(`[Engine] Cannot execute ${request.action}: critical sync error`);
                    this.stats.blocked++;
                    throw new Error(`Critical sync error: ${syncStatus.status}`);
                }
                // Не блокируем при pending - это нормально
            }
        }

        const startTime = Date.now();
        this.stats.total++;
        logger.info(`[Engine] Executing ${request.action}: ${request.clientOrderId} @ ${request.price || 'market'}`);

        try {
            let result, attempts = 0, lastError = null;
            while (attempts < this.maxRetries) {
                try {
                    result = await this.executeWithTimeout(request);
                    break;
                } catch (e) {
                    attempts++;
                    lastError = e;
                    if (attempts < this.maxRetries) {
                        const delay = this.retryDelay * Math.pow(2, attempts - 1);
                        logger.warn(`[Engine] Retry ${attempts}/${this.maxRetries} for ${request.clientOrderId}: ${e.message}`);
                        await this.sleep(delay / 1000);
                        this.stats.retries++;
                    }
                }
            }

            if (!result || !result.success) {
                throw new Error(`Broker request failed: ${lastError?.message || 'Unknown error'}`);
            }

            const confirmed = await this.waitForConfirmation(request, result);
            const duration = Date.now() - startTime;
            const executionResult = new ExecutionResult({
                requestId: request.requestId,
                clientOrderId: request.clientOrderId,
                brokerOrderId: result.brokerOrderId || null,
                success: confirmed,
                status: confirmed ? 'CONFIRMED' : 'TIMEOUT',
                source: confirmed ? (result.source || 'ws') : 'timeout',
                data: confirmed ? result : null,
                attempts: attempts + 1
            });

            if (confirmed) {
                this.stats.successful++;
                logger.ok(`[Engine] ${request.action} confirmed: ${request.clientOrderId} (${duration}ms)`);
            } else {
                this.stats.failed++;
                this.stats.timeouts++;
                logger.err(`[Engine] ${request.action} timeout: ${request.clientOrderId} (${duration}ms)`);
            }

            this.emit('execution_complete', executionResult);
            return executionResult;

        } catch (e) {
            this.stats.failed++;
            logger.err(`[Engine] ${request.action} failed: ${request.clientOrderId} - ${e.message}`);
            const executionResult = new ExecutionResult({
                requestId: request.requestId,
                clientOrderId: request.clientOrderId,
                success: false,
                status: 'ERROR',
                error: e.message,
                attempts: 1
            });
            this.emit('execution_error', { request, error: e });
            throw e;
        }
    }

    async executeWithTimeout(request) {
        return Promise.race([
            this.executeBrokerRequest(request),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Broker request timeout (${this.timeout}ms)`)), this.timeout))
        ]);
    }

    async executeBrokerRequest(request) {
        switch (request.action) {
            case 'CREATE': return this.brokerAdapter.createOrder(request);
            case 'MODIFY': return this.brokerAdapter.modifyOrder(request);
            case 'CANCEL': return this.brokerAdapter.cancelOrder(request);
            default: throw new Error(`Unknown action: ${request.action}`);
        }
    }

    async waitForConfirmation(request, brokerResult) {
        const { clientOrderId, strategyId, action } = request;
        if (!brokerResult || !brokerResult.success) return false;

        const wsResult = await this.waitForWsConfirmation(strategyId, clientOrderId, action);
        if (wsResult.confirmed) {
            logger.info(`[Engine] ${action} confirmed via WS: ${clientOrderId} (status: ${wsResult.status})`);
            this.stats.wsConfirmed++;
            return true;
        }

        logger.warn(`[Engine] ⏰ WS timeout for ${clientOrderId} (${wsResult.reason || 'no event'}), checking via REST...`);
        const restConfirmed = await this.checkRestStatus(brokerResult.orderId || clientOrderId, action);
        if (restConfirmed) {
            logger.info(`[Engine] ${action} confirmed via REST: ${clientOrderId}`);
            this.stats.restConfirmed++;
            return true;
        }

        logger.err(`[Engine] No confirmation for ${clientOrderId} from WS or REST`);
        return false;
    }

    waitForWsConfirmation(strategyId, clientOrderId, expectedAction) {
        const timeout = this.confirmationTimeout || 3000;
        return new Promise((resolve) => {
            if (!this.orderManager) {
                resolve({ confirmed: false, status: null, reason: 'no order manager' });
                return;
            }

            const stack = this.orderManager.getStack(strategyId);
            if (!stack) {
                resolve({ confirmed: false, status: null, reason: 'no stack' });
                return;
            }

            const order = stack.getOrder(clientOrderId);
            if (order && order.wsConfirmed) {
                resolve({ confirmed: true, status: order.status, reason: 'already confirmed' });
                return;
            }

            if (!stack.isPending(clientOrderId)) {
                if (stack._pendingWsConfirmations?.has(clientOrderId)) {
                    const wsData = stack._pendingWsConfirmations.get(clientOrderId);
                    if (wsData.confirmed) {
                        resolve({ confirmed: true, status: wsData.status || 'CONFIRMED', reason: 'ws confirmed' });
                        return;
                    }
                }
                resolve({ confirmed: false, status: null, reason: 'not pending' });
                return;
            }

            let resolved = false;
            const timeoutId = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    resolve({ confirmed: false, status: null, reason: 'timeout' });
                }
            }, timeout);

            const handler = (data) => {
                const orderData = data.order || data;
                if (orderData.clientOrderId === clientOrderId) {
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeoutId);
                        const status = orderData.status || data.status;
                        const isSuccess = this.isExpectedStatus(status, expectedAction);
                        resolve({
                            confirmed: isSuccess,
                            status: status,
                            reason: isSuccess ? 'ws event' : `unexpected status: ${status}`
                        });
                    }
                }
            };

            stack.once('order_confirmed', handler);
            stack.once('order_updated', handler);
            stack.once('order_closed', handler);
        });
    }

    isExpectedStatus(status, action) {
        const expected = {
            'CREATE': ['CREATED', '0', 'PENDING', 'ACTIVE'],
            'MODIFY': ['MODIFIED', '5', 'ACTIVE'],
            'CANCEL': ['CANCELLED', '4', 'CLOSED'],
        };
        const expectedStatuses = expected[action] || [];
        return expectedStatuses.some(s => String(status) === String(s) || status.includes(s));
    }

    async checkRestStatus(orderId, action) {
        if (!this.brokerAdapter) return false;
        try {
            const status = await this.brokerAdapter.getOrderStatus(orderId);
            const successStatuses = ['0', '1', '2', '4', '5'];
            if (successStatuses.includes(status)) return true;
            logger.debug(`[Engine] REST status for ${orderId}: ${status}`);
            return false;
        } catch (e) {
            logger.err(`[Engine] REST status check error: ${e.message}`);
            return false;
        }
    }

    getStats() {
        return {
            ...this.stats,
            successRate: this.stats.total > 0 ? ((this.stats.successful / this.stats.total) * 100).toFixed(1) + '%' : '0%',
            pendingRequests: this._pendingRequests.size
        };
    }

    async shutdown() {
        this._isShuttingDown = true;
        let attempts = 0;
        while (this._pendingRequests.size > 0 && attempts < 10) {
            await this.sleep(0.1);
            attempts++;
        }
        if (this._pendingRequests.size > 0) {
            for (const [id, data] of this._pendingRequests) {
                if (data.timer) clearTimeout(data.timer);
            }
            this._pendingRequests.clear();
        }
        if (this.executionQueue) this.executionQueue.clear();
        logger.info('[Engine] Shutdown complete');
    }

    sleep(seconds) {
        return new Promise(resolve => setTimeout(resolve, seconds * 1000));
    }
}

module.exports = ExecutionEngine;