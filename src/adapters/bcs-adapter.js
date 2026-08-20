const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

class BcsAdapter {
    constructor(restApi) {
        this.restApi = restApi;
    }

    async createOrder(request) {
        const clientOrderId = request.clientOrderId || uuidv4();
        // Приводим quantity к числу
        const quantity = typeof request.quantity === 'string' ? parseFloat(request.quantity) : (request.quantity || 1);
        const price = typeof request.price === 'string' ? parseFloat(request.price) : (request.price || 0);

        const params = {
            clientOrderId: clientOrderId,
            price: price,
            orderQuantity: quantity,
            ticker: request.symbol || 'SBER',
            classCode: request.classCode || 'TQBR',
            side: request.side === 'BUY' ? '1' : '2',
            orderType: request.orderType === 'LIMIT' ? '2' : '1',
        };
        logger.info(`[BcsAdapter] Creating order: ${params.clientOrderId} @ ${params.price} x ${params.orderQuantity}`);
        try {
            const response = await this.restApi.createOrder(params);
            if (response.status === 'OK') {
                return { success: true, orderId: clientOrderId, brokerOrderId: null, status: 'PENDING', source: 'rest' };
            }
            throw new Error(`Create order failed: ${JSON.stringify(response)}`);
        } catch (e) {
            logger.err(`[BcsAdapter] Create order error: ${e.message}`);
            throw e;
        }
    }

    async modifyOrder(request) {
        if (!request.orderId) throw new Error('modifyOrder: orderId is required');
        const newClientOrderId = request.clientOrderId || uuidv4();
        // Приводим quantity к числу
        const quantity = typeof request.quantity === 'string' ? parseFloat(request.quantity) : (request.quantity || 1);
        const price = typeof request.price === 'string' ? parseFloat(request.price) : (request.price || 0);

        const params = {
            orderIdType: '2',
            orderId: request.orderId,
            clientOrderId: newClientOrderId,
            price: price,
            orderQuantity: quantity,
            ticker: request.symbol || 'SBER',
            classCode: request.classCode || 'TQBR',
            orderType: request.orderType === 'LIMIT' ? '2' : '1',
        };
        logger.info(`[BcsAdapter] Modifying order: ${request.orderId} → ${newClientOrderId} @ ${params.price} x ${params.orderQuantity}`);
        try {
            const response = await this.restApi.modifyOrder(params);
            if (response.status === 'OK') {
                return { success: true, orderId: newClientOrderId, brokerOrderId: null, status: 'PENDING_MODIFY', source: 'rest' };
            }
            throw new Error(`Modify order failed: ${JSON.stringify(response)}`);
        } catch (e) {
            logger.err(`[BcsAdapter] Modify order error: ${e.message}`);
            throw e;
        }
    }

    async cancelOrder(request) {
        if (!request.orderId) throw new Error('cancelOrder: orderId is required');
        const newClientOrderId = request.clientOrderId || uuidv4();
        const params = {
            orderIdType: '2',
            orderId: request.orderId,
            clientOrderId: newClientOrderId,
        };
        logger.info(`[BcsAdapter] Cancelling order: ${request.orderId}`);
        try {
            const response = await this.restApi.cancelOrder(params);
            if (response.status === 'OK' || response.type === 'BAD_REQUEST') {
                return { success: true, orderId: request.orderId, status: 'CANCELLED', source: 'rest', clientOrderId: newClientOrderId };
            }
            throw new Error(`Cancel order failed: ${JSON.stringify(response)}`);
        } catch (e) {
            logger.err(`[BcsAdapter] Cancel order error: ${e.message}`);
            throw e;
        }
    }

    async getOrderStatusByUUID(uuid) {
        if (!uuid) return null;
        try {
            const response = await this.restApi.requestWithRetry('GET', `/trade-api-bff-operations/api/v1/orders?orderIdType=1&orderId=${uuid}`);
            if (response.statusCode === 200 && response.body) {
                return {
                    success: true,
                    data: response.body,
                    clientOrderId: response.body.clientOrderId || uuid,
                    originalClientOrderId: response.body.originalClientOrderId || uuid,
                    orderStatus: response.body.data?.orderStatus || null,
                    brokerOrderId: response.body.data?.orderId || null,
                    ...response.body.data
                };
            }
            return null;
        } catch (e) {
            if (!e.message?.includes('404')) logger.warn(`[BcsAdapter] Status check error for ${uuid}: ${e.message}`);
            return null;
        }
    }

    async getOrderStatusByBrokerId(brokerOrderId) {
        if (!brokerOrderId) return null;
        try {
            const response = await this.restApi.requestWithRetry('GET', `/trade-api-bff-operations/api/v1/orders?orderIdType=2&orderId=${brokerOrderId}`);
            if (response.statusCode === 200 && response.body) {
                return {
                    success: true,
                    data: response.body,
                    clientOrderId: response.body.clientOrderId || null,
                    originalClientOrderId: response.body.originalClientOrderId || null,
                    orderStatus: response.body.data?.orderStatus || null,
                    brokerOrderId: response.body.data?.orderId || brokerOrderId,
                    ...response.body.data
                };
            }
            return null;
        } catch (e) {
            if (!e.message?.includes('404')) logger.warn(`[BcsAdapter] Status check error for ${brokerOrderId}: ${e.message}`);
            return null;
        }
    }

    async getOrderStatus(orderId) {
        if (!orderId) return null;
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const result = uuidRegex.test(orderId) ?
            await this.getOrderStatusByUUID(orderId) :
            await this.getOrderStatusByBrokerId(orderId);
        return result?.orderStatus || null;
    }

    async getActiveOrdersList(options = {}) {
        try {
            const searchBody = {
                orderStatus: [3],
                tickers: options.ticker ? [options.ticker] : undefined,
                classCodes: options.classCode ? [options.classCode] : undefined,
                startDateTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
                endDateTime: new Date().toISOString(),
            };
            Object.keys(searchBody).forEach(key => {
                if (searchBody[key] === undefined) delete searchBody[key];
            });
            const response = await this.restApi.requestWithRetry('POST', '/trade-api-bff-order-details/api/v1/orders/search?page=0&size=100', searchBody);
            if (response?.body?.records) {
                logger.info(`[BcsAdapter] Found ${response.body.records.length} active orders`);
                return response.body.records;
            }
            return [];
        } catch (e) {
            logger.warn(`[BcsAdapter] getActiveOrdersList error: ${e.message}`);
            return [];
        }
    }

    async getActiveOrdersWithDetails(options = {}) {
        const records = await this.getActiveOrdersList(options);
        const result = [];
        const addedBrokerOrderIds = new Set();

        for (const record of records) {
            const brokerOrderId = record.orderId;
            if (addedBrokerOrderIds.has(brokerOrderId)) continue;

            const statusResult = await this.getOrderStatusByBrokerId(brokerOrderId);
            if (!statusResult?.success) continue;

            const orderStatus = statusResult.orderStatus;
            const originalClientOrderId = statusResult.originalClientOrderId || null;
            const currentClientOrderId = statusResult.clientOrderId || null;

            const activeStatuses = ['0', '1', '3', '5'];
            if (!activeStatuses.includes(orderStatus)) continue;
            if (orderStatus === '9') continue;

            const order = {
                clientOrderId: currentClientOrderId || brokerOrderId,
                orderId: brokerOrderId,
                brokerOrderId: brokerOrderId,
                price: record.price || statusResult.price || 0,
                quantity: record.orderQuantity || statusResult.orderQuantity || 0,
                filledQuantity: record.executedQuantity || statusResult.executedQuantity || 0,
                remainingQuantity: record.remainedQuantity || statusResult.remainedQuantity || 0,
                status: this.mapOrderStatus(orderStatus),
                orderStatus: orderStatus,
                side: record.side === 1 ? 'BUY' : 'SELL',
                orderType: this.mapOrderType(record.orderType || statusResult.orderType),
                symbol: record.ticker || statusResult.ticker || 'SBER',
                classCode: record.classCode || statusResult.classCode || 'TQBR',
                createdAt: new Date(record.orderDateTime || statusResult.transactionTime || Date.now()),
                updatedAt: new Date(record.updateDateTime || statusResult.transactionTime || Date.now()),
                replacedOrderId: orderStatus === '5' ? originalClientOrderId : null,
                originalClientOrderId: orderStatus === '5' ? originalClientOrderId : null,
                wsConfirmed: false,
                restConfirmed: true,
                synced: true,
            };
            result.push(order);
            addedBrokerOrderIds.add(brokerOrderId);
        }

        logger.info(`[BcsAdapter] Retrieved ${result.length} active orders`);
        return result;
    }

    async syncOrdersByList(options = {}) {
        return await this.getActiveOrdersWithDetails(options);
    }

    mapOrderStatus(status) {
        const map = {
            '1': 'CANCELLED', '2': 'FILLED', '3': 'ACTIVE',
            '0': 'PENDING', '4': 'CANCELLED', '5': 'REPLACED',
            '6': 'CANCELLING', '7': 'REJECTED', '8': 'ERROR',
            '9': 'REPLACING', '10': 'PENDING'
        };
        return map[String(status)] || 'UNKNOWN';
    }

    mapOrderType(type) {
        const map = {
            '1': 'MARKET', '2': 'LIMIT', '3': 'ICEBERG',
            '4': 'STOP_LIMIT', '5': 'TAKE_PROFIT', '6': 'STOP_LOSS',
            '7': 'TAKE_PROFIT_STOP_LOSS', '10': 'LIMIT_30_DAYS',
            '11': 'TAKE_PROFIT', '12': 'TRAILING_STOP'
        };
        return map[String(type)] || 'UNKNOWN';
    }
}

module.exports = BcsAdapter;