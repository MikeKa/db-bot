const EventEmitter = require('events');
const logger = require('../../utils/logger');

class ExecutionQueue extends EventEmitter {
    constructor(options = {}) {
        super();
        this.queues = { CRITICAL: [], HIGH: [], NORMAL: [] };
        this.processing = false;
        this.maxQueueSize = options.maxQueueSize || 1000;
        this.stats = { enqueued: 0, processed: 0, rejected: 0, maxWaitTime: 0, avgWaitTime: 0, totalWaitTime: 0 };
        this._processingTimer = null;
    }

    getPriority(action) {
        switch (action) { case 'CANCEL': return 'CRITICAL'; case 'MODIFY': return 'HIGH'; default: return 'NORMAL'; }
    }

    enqueue(request) {
        const priority = this.getPriority(request.action);
        const queue = this.queues[priority];
        const totalSize = this.getTotalSize();
        if (totalSize >= this.maxQueueSize) {
            logger.warn(`[Queue] Queue full, rejecting request`);
            this.stats.rejected++;
            this.emit('rejected', request);
            return false;
        }
        request.enqueuedAt = Date.now();
        queue.push(request);
        this.stats.enqueued++;
        logger.info(`[Queue] Enqueued ${request.action} (${priority}): ${request.clientOrderId}`);
        this.emit('enqueued', request);
        if (!this.processing) this.processNext();
        return true;
    }

    getTotalSize() { return this.queues.CRITICAL.length + this.queues.HIGH.length + this.queues.NORMAL.length; }

    dequeue() {
        if (this.queues.CRITICAL.length > 0) return this.queues.CRITICAL.shift();
        if (this.queues.HIGH.length > 0) return this.queues.HIGH.shift();
        if (this.queues.NORMAL.length > 0) return this.queues.NORMAL.shift();
        return null;
    }

    async processNext() {
        if (this.processing) return;
        const request = this.dequeue();
        if (!request) {
            if (this._processingTimer) { clearTimeout(this._processingTimer); this._processingTimer = null; }
            return;
        }
        this.processing = true;
        try {
            const waitTime = Date.now() - (request.enqueuedAt || Date.now());
            this.stats.totalWaitTime += waitTime;
            this.stats.maxWaitTime = Math.max(this.stats.maxWaitTime, waitTime);
            this.stats.processed++;
            this.emit('processing', request);
            const result = await this.executeRequest(request);
            this.emit('completed', { request, result });
        } catch (e) {
            logger.err(`[Queue] Execution error: ${e.message}`);
            this.emit('error', { request, error: e });
        } finally {
            this.processing = false;
            if (this.getTotalSize() > 0) {
                this._processingTimer = setTimeout(() => this.processNext(), 10);
            } else {
                this._processingTimer = null;
                this.emit('empty');
            }
        }
    }

    async executeRequest(request) { throw new Error('executeRequest must be implemented by Execution Engine'); }
    clear() { this.queues = { CRITICAL: [], HIGH: [], NORMAL: [] }; this.processing = false; }

    getStats() {
        return {
            ...this.stats,
            avgWaitTime: this.stats.processed > 0 ? (this.stats.totalWaitTime / this.stats.processed).toFixed(0) + 'ms' : '0ms',
            queueSizes: { CRITICAL: this.queues.CRITICAL.length, HIGH: this.queues.HIGH.length, NORMAL: this.queues.NORMAL.length, TOTAL: this.getTotalSize() },
            processing: this.processing
        };
    }
}

module.exports = ExecutionQueue;
