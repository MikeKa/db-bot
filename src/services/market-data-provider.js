const WebSocket = require('ws');
const config = require('../config');
const auth = require('./auth');
const logger = require('../utils/logger');
const EventEmitter = require('events');
const strategyConfig = require('../config/strategy');

class MarketDataProvider extends EventEmitter {
    constructor() {
        super();
        this.ws = null;
        this.isConnected = false;
        this.isSubscribed = false;
        this.orderBook = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = config.wsMaxReconnectAttempts || 20;
        this.messageCount = 0;
        this.lastUpdateTime = null;
        this.updateFrequency = 0;
        this._updateCounter = 0;
        this._lastFrequencyCheck = Date.now();
        this._firstDataReceived = false;
        this._lastDataReceived = null;
        this._isReconnecting = false;
        this.dataStaleThreshold = 15000;
        this.reconnectCooldown = 2000;
        this._lastReconnectAttempt = 0;
        this.reconnectTimer = null;
        this._reconnectDelay = 2000;
        this._maxReconnectDelay = 30000;
        this._jitterRange = 500;
    }

    async connect() {
        if (this._isReconnecting) {
            return new Promise((resolve) => {
                const checkConnection = setInterval(() => {
                    if (!this._isReconnecting) {
                        clearInterval(checkConnection);
                        resolve(this.isConnected);
                    }
                }, 100);
            });
        }
        const now = Date.now();
        if (now - this._lastReconnectAttempt < this.reconnectCooldown) {
            await this.sleep((this.reconnectCooldown - (now - this._lastReconnectAttempt)) / 1000);
        }
        this._lastReconnectAttempt = now;

        const token = await auth.getAccessToken();
        return new Promise((resolve, reject) => {
            try {
                if (this.ws) {
                    try { this.ws.removeAllListeners(); this.ws.close(); } catch (e) { }
                    this.ws = null;
                }
                this._isReconnecting = true;
                this.ws = new WebSocket(config.wsMarketUrl, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                const connectTimeout = setTimeout(() => {
                    if (!this.isConnected) {
                        this.ws.close();
                        this._isReconnecting = false;
                        reject(new Error('Connection timeout'));
                    }
                }, config.wsConnectTimeout || 10000);

                this.ws.on('open', () => {
                    clearTimeout(connectTimeout);
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    this._isReconnecting = false;
                    this._lastDataReceived = Date.now();
                    logger.wsLog('✅ Market WS Connected');
                    this.subscribe().then(() => resolve(true)).catch(() => resolve(true));
                });

                this.ws.on('message', (data) => { this.handleMessage(data); });
                this.ws.on('ping', () => {
                    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.pong();
                });
                this.ws.on('error', (error) => {
                    logger.wsLog(`❌ Market WS Error: ${error.message}`);
                    clearTimeout(connectTimeout);
                    if (!this.isConnected) {
                        this._isReconnecting = false;
                        reject(error);
                    }
                });
                this.ws.on('close', () => {
                    clearTimeout(connectTimeout);
                    this.isConnected = false;
                    this.isSubscribed = false;
                    this._firstDataReceived = false;
                    this._isReconnecting = false;
                    logger.wsLog('⚠️ Market WS Disconnected');
                    this.emit('disconnected');
                    this.reconnect();
                });
            } catch (e) {
                this._isReconnecting = false;
                reject(e);
            }
        });
    }

    async forceReconnect() {
        logger.wsLog('🔄 Force reconnecting...');
        this._firstDataReceived = false;
        this.orderBook = null;
        this.isSubscribed = false;
        this._isReconnecting = false;
        if (this.ws) {
            try { this.ws.close(); } catch (e) { }
            this.ws = null;
        }
        await this.sleep(0.5);
        return this.connect();
    }

    // ============================================================
    // РАЗДЕЛЬНЫЙ RECONNECT С JITTER (0-500ms)
    // ============================================================
    reconnect() {
        if (this._isReconnecting || this.reconnectAttempts >= this.maxReconnectAttempts) {
            if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                logger.wsLog('❌ Market WS max reconnect attempts reached');
            }
            return;
        }

        this.reconnectAttempts++;
        this._isReconnecting = true;

        let delay = this._reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1);
        delay = Math.min(delay, this._maxReconnectDelay);

        // Jitter 0-500ms для разделения переподключений
        const jitter = Math.random() * this._jitterRange;
        const totalDelay = delay + jitter;

        logger.wsLog(`🔄 Market WS reconnecting in ${(totalDelay / 1000).toFixed(2)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(async () => {
            try {
                await this.forceReconnect();
                this.reconnectAttempts = 0;
                this._isReconnecting = false;
                this.emit('reconnected');
                logger.ok('✅ Market WS reconnected successfully');
            } catch (e) {
                logger.wsLog(`❌ Market WS reconnect failed: ${e.message}`);
                this._isReconnecting = false;
                this.reconnect();
            }
        }, totalDelay);
    }

    hasValidData() {
        if (!this.orderBook || !this.orderBook.bids || !this.orderBook.asks ||
            this.orderBook.bids.length === 0 || this.orderBook.asks.length === 0) {
            return false;
        }
        if (this._lastDataReceived && Date.now() - this._lastDataReceived > 30000) {
            return false;
        }
        return true;
    }

    getOrderBook() {
        if (!this.hasValidData()) {
            if (this.isConnected && !this._isReconnecting) this.forceReconnect();
            return null;
        }
        return this.orderBook;
    }

    handleMessage(data) {
        try {
            const payload = JSON.parse(data.toString());
            this.messageCount++;
            this._updateCounter++;
            const now = Date.now();
            if (now - this._lastFrequencyCheck >= 1000) {
                this.updateFrequency = this._updateCounter;
                this._updateCounter = 0;
                this._lastFrequencyCheck = now;
            }

            if (payload.responseType === 'OrderBookSuccess') {
                logger.wsLog(`✅ Subscribed to ${payload.ticker} depth ${payload.depth}`);
                return;
            }

            if (payload.responseType === 'OrderBook') {
                if (!payload.bids || !payload.asks || payload.bids.length === 0 || payload.asks.length === 0) {
                    return;
                }
                this.orderBook = {
                    ticker: payload.ticker,
                    classCode: payload.classCode,
                    depth: payload.depth,
                    dateTime: payload.dateTime,
                    bidVolume: payload.bidVolume,
                    askVolume: payload.askVolume,
                    bids: payload.bids || [],
                    asks: payload.asks || [],
                    spread: this.calculateSpread(payload)
                };
                this._lastDataReceived = Date.now();
                this.lastUpdateTime = new Date();
                if (!this._firstDataReceived) {
                    this._firstDataReceived = true;
                    logger.ok('✅ First market data received!');
                }
                this.emit('orderbook', this.orderBook);
            }
        } catch (e) {
            logger.wsLog(`❌ Market WS Parse error: ${e.message}`);
        }
    }

    disconnect() {
        this._isReconnecting = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            try { this.unsubscribe(); this.ws.close(); } catch (e) { }
            this.ws = null;
        }
        this.isConnected = false;
        this.isSubscribed = false;
        this._firstDataReceived = false;
        this._isReconnecting = false;
        logger.wsLog('🔌 Market WS Disconnected');
    }

    sleep(seconds) {
        return new Promise(resolve => setTimeout(resolve, seconds * 1000));
    }

    async subscribe() {
        if (!this.isConnected) {
            logger.wsLog('❌ Cannot subscribe: not connected');
            throw new Error('Not connected');
        }
        const message = {
            subscribeType: 0,
            dataType: 0,
            depth: 20,
            instruments: [{ ticker: strategyConfig.instrument.ticker, classCode: strategyConfig.instrument.classCode }]
        };
        try {
            this.ws.send(JSON.stringify(message));
            logger.wsLog(`📤 Subscribed to ${strategyConfig.instrument.ticker}/${strategyConfig.instrument.classCode}`);
            this.isSubscribed = true;
        } catch (e) {
            logger.wsLog(`❌ Subscribe error: ${e.message}`);
            throw e;
        }
    }

    unsubscribe() {
        if (!this.isConnected || !this.isSubscribed) return;
        const message = {
            subscribeType: 1,
            dataType: 0,
            instruments: [{ ticker: strategyConfig.instrument.ticker, classCode: strategyConfig.instrument.classCode }]
        };
        try {
            this.ws.send(JSON.stringify(message));
            logger.wsLog('📤 Unsubscribed');
        } catch (e) { }
        this.isSubscribed = false;
    }

    calculateSpread(payload) {
        if (!payload.bids || !payload.asks || !payload.bids.length || !payload.asks.length) return null;
        return payload.asks[0].price - payload.bids[0].price;
    }

    getMidPrice() {
        if (!this.hasValidData()) return null;
        return (this.orderBook.bids[0].price + this.orderBook.asks[0].price) / 2;
    }

    getStats() {
        const now = Date.now();
        return {
            isConnected: this.isConnected,
            isSubscribed: this.isSubscribed,
            hasData: this.hasValidData(),
            messageCount: this.messageCount,
            updateFrequency: this.updateFrequency,
            lastUpdateTime: this.lastUpdateTime,
            secondsSinceLastData: this._lastDataReceived ? ((now - this._lastDataReceived) / 1000).toFixed(1) : 'N/A',
            orderBook: this.orderBook,
            midPrice: this.getMidPrice(),
            spread: this.orderBook ? this.orderBook.spread : null,
            reconnectAttempts: this.reconnectAttempts,
            isReconnecting: this._isReconnecting
        };
    }

    // Добавляем метод для принудительного закрытия
    forceClose() {
        this._isReconnecting = false;
        this.stopHeartbeat();

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.ws) {
            try {
                this.ws.removeAllListeners();
                this.ws.close(1000, 'Force close');
            } catch (e) { }
            this.ws = null;
        }

        this.isConnected = false;
        this.isSubscribed = false;
        logger.wsLog('🔌 Market WS force closed');
    }
}

module.exports = new MarketDataProvider();