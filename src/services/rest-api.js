const https = require('https');
const auth = require('./auth');
const config = require('../config');
const logger = require('../utils/logger');

class RestApiService {
    constructor() {
        this.stats = { totalRequests: 0, successfulRequests: 0, failedRequests: 0, totalTime: 0, minTime: Infinity, maxTime: 0, retries: 0, errors: [] };
        this._lastRequestId = 0;
    }

    async request(method, path, body = null) {
        const startTime = Date.now();
        this.stats.totalRequests++;
        const requestId = ++this._lastRequestId;
        logger.info(`[REST #${requestId}] ${method} ${path}`);

        try {
            const token = await auth.getAccessToken();
            const options = {
                hostname: new URL(config.baseUrl).hostname,
                path: path,
                method: method,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${token}`,
                },
            };

            return new Promise((resolve, reject) => {
                const req = https.request(options, (res) => {
                    let data = '';
                    res.on('data', (chunk) => { data += chunk; });
                    res.on('end', () => {
                        const duration = Date.now() - startTime;
                        this.updateStats(duration, true);
                        let parsedBody;
                        try { parsedBody = JSON.parse(data); } catch (e) { parsedBody = data; }
                        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsedBody });
                    });
                });
                req.on('error', (e) => {
                    const duration = Date.now() - startTime;
                    this.updateStats(duration, false, e.message);
                    reject(e);
                });
                req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timeout')); });
                if (body) { req.write(JSON.stringify(body)); }
                req.end();
            });
        } catch (e) { throw e; }
    }

    async requestWithRetry(method, path, body = null, retryCount = 0) {
        const maxRetries = config.maxRetries || 10;
        const retryDelay = config.retryDelay || 1.0;
        try {
            return await this.request(method, path, body);
        } catch (e) {
            if (retryCount >= maxRetries) throw e;
            this.stats.retries = (this.stats.retries || 0) + 1;
            await this.sleep(retryDelay * Math.pow(2, retryCount));
            return this.requestWithRetry(method, path, body, retryCount + 1);
        }
    }

    async createOrder(params) {
        const body = {
            clientOrderId: params.clientOrderId,
            side: params.side || '1',
            orderType: params.orderType || '2',
            orderQuantity: params.orderQuantity || 1,
            ticker: params.ticker || 'SBER',
            classCode: params.classCode || 'TQBR',
            price: params.price
        };
        const response = await this.requestWithRetry('POST', '/trade-api-bff-operations/api/v1/orders', body);
        return response.body;
    }

    async modifyOrder(params) {
        const body = {
            orderIdType: params.orderIdType || '1',
            orderId: params.orderId,
            clientOrderId: params.clientOrderId,
            orderType: params.orderType || '2',
            orderQuantity: params.orderQuantity || 1,
            price: params.price,
            ticker: params.ticker || 'SBER',
            classCode: params.classCode || 'TQBR'
        };
        const response = await this.requestWithRetry('POST', '/trade-api-bff-operations/api/v1/orders/edit', body);
        return response.body;
    }

    async cancelOrder(params) {
        const body = {
            orderIdType: params.orderIdType || '1',
            orderId: params.orderId,
            clientOrderId: params.clientOrderId
        };
        const response = await this.requestWithRetry('POST', '/trade-api-bff-operations/api/v1/orders/cancel', body);
        return response.body;
    }

    updateStats(duration, success, error = null) {
        if (success) {
            this.stats.successfulRequests++;
            this.stats.totalTime += duration;
            if (duration < this.stats.minTime) this.stats.minTime = duration;
            if (duration > this.stats.maxTime) this.stats.maxTime = duration;
        } else {
            this.stats.failedRequests++;
            if (error) {
                this.stats.errors.push({ time: new Date(), error });
                if (this.stats.errors.length > 100) this.stats.errors.shift();
            }
        }
    }

    sleep(seconds) { return new Promise(resolve => setTimeout(resolve, seconds * 1000)); }

    getStats() {
        const avgTime = this.stats.totalRequests > 0 ? this.stats.totalTime / this.stats.totalRequests : 0;
        return {
            totalRequests: this.stats.totalRequests,
            successfulRequests: this.stats.successfulRequests,
            failedRequests: this.stats.failedRequests,
            successRate: this.stats.totalRequests > 0 ? (this.stats.successfulRequests / this.stats.totalRequests * 100).toFixed(1) + '%' : '0%',
            avgTime: avgTime.toFixed(0) + 'ms',
            minTime: this.stats.minTime === Infinity ? 0 : this.stats.minTime + 'ms',
            maxTime: this.stats.maxTime + 'ms',
            retries: this.stats.retries || 0,
            lastErrors: this.stats.errors.slice(-5),
        };
    }
}

module.exports = new RestApiService();
