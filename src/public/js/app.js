const CONFIG = {
    BASE_PATH: window.location.pathname.startsWith('/bot') ? '/bot' : '',
    MAX_LOG_LINES: 100,
};

const API = { get BASE_URL() { return CONFIG.BASE_PATH + '/api'; } };

const state = {
    isRunning: false,
    strategies: [],
    activeTab: null,
    uptimeSeconds: 0,
    wsOrderBook: null,
    wsOrderBookConnected: false,
    wsTransactions: null,
    wsTransactionsConnected: false,
    wsStackUpdates: null,
    wsStackUpdatesConnected: false,
    activeOrders: [],
    historyOrders: [],
    strategyStates: {},
};

const DOM = {};

function cacheDomRefs() {
    DOM.statusBadge = document.getElementById('statusBadge');
    DOM.uptime = document.getElementById('uptime');
    DOM.btnStart = document.getElementById('btnStart');
    DOM.btnStop = document.getElementById('btnStop');
    DOM.btnCancel = document.getElementById('btnCancel');
    DOM.statStrategies = document.getElementById('statStrategies');
    DOM.statActiveOrders = document.getElementById('statActiveOrders');
    DOM.statPending = document.getElementById('statPending');
    DOM.statHistory = document.getElementById('statHistory');
    DOM.statQueue = document.getElementById('statQueue');

    DOM.wsMarket = document.getElementById('wsMarket');
    DOM.wsTransactions = document.getElementById('wsTransactions');
    DOM.authStatus = document.getElementById('authStatus');

    DOM.riskPosition = document.getElementById('riskPosition');
    DOM.riskPnL = document.getElementById('riskPnL');
    DOM.riskCircuit = document.getElementById('riskCircuit');
    DOM.riskDailyOrders = document.getElementById('riskDailyOrders');
    DOM.tabsHeader = document.getElementById('tabsHeader');
    DOM.tabContent = document.getElementById('tabContent');
    DOM.log = document.getElementById('log');
    DOM.timestamp = document.getElementById('timestamp');
}

async function apiCall(endpoint, options = {}) {
    const url = API.BASE_URL + endpoint;
    try {
        const response = await fetch(url, {
            ...options,
            headers: { 'Content-Type': 'application/json' },
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        return data;
    } catch (e) {
        console.error('API Error:', e.message, endpoint);
        return null;
    }
}

function updateConnectionsUI() {
    console.log('[DEBUG] Updating connections UI...');

    if (DOM.wsMarket) {
        const connected = state.wsOrderBookConnected;
        DOM.wsMarket.textContent = connected ? '🟢 Connected' : '🔴 Disconnected';
        DOM.wsMarket.className = 'conn-value ' + (connected ? 'green' : 'red');
    }

    if (DOM.wsTransactions) {
        const connected = state.wsTransactionsConnected;
        DOM.wsTransactions.textContent = connected ? '🟢 Connected' : '🔴 Disconnected';
        DOM.wsTransactions.className = 'conn-value ' + (connected ? 'green' : 'red');
    }
}

// ============================================================
// WEBSOCKET CONNECTIONS
// ============================================================
function connectOrderBookWS() {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}${CONFIG.BASE_PATH}/api/ws/orderbook`;

    if (state.wsOrderBook) {
        try { state.wsOrderBook.close(); } catch (e) { }
        state.wsOrderBook = null;
    }

    try {
        state.wsOrderBook = new WebSocket(wsUrl);

        state.wsOrderBook.onopen = () => {
            state.wsOrderBookConnected = true;
            updateConnectionsUI();
            addLog('📡 OrderBook WS connected', 'success');
        };

        state.wsOrderBook.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'orderbook') updateOrderBookUI(data.book);
            } catch (e) { }
        };

        state.wsOrderBook.onclose = () => {
            state.wsOrderBookConnected = false;
            updateConnectionsUI();
            addLog('📡 OrderBook WS disconnected, reconnecting...', 'warning');
            setTimeout(connectOrderBookWS, 3000 + Math.random() * 500);
        };

        state.wsOrderBook.onerror = (error) => {
            console.error('OrderBook WS error:', error);
        };

    } catch (e) {
        console.error('OrderBook WS connection error:', e);
        setTimeout(connectOrderBookWS, 5000 + Math.random() * 500);
    }
}

function connectTransactionsWS() {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}${CONFIG.BASE_PATH}/api/ws/transactions`;

    if (state.wsTransactions) {
        try { state.wsTransactions.close(); } catch (e) { }
        state.wsTransactions = null;
    }

    try {
        state.wsTransactions = new WebSocket(wsUrl);

        state.wsTransactions.onopen = () => {
            state.wsTransactionsConnected = true;
            updateConnectionsUI();
            addLog('📡 Transactions WS connected', 'success');
        };

        state.wsTransactions.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'transaction') handleTransaction(data.payload);
            } catch (e) { }
        };

        state.wsTransactions.onclose = () => {
            state.wsTransactionsConnected = false;
            updateConnectionsUI();
            addLog('📡 Transactions WS disconnected, reconnecting...', 'warning');
            setTimeout(connectTransactionsWS, 3000 + Math.random() * 500);
        };

        state.wsTransactions.onerror = (error) => {
            console.error('Transactions WS error:', error);
        };

    } catch (e) {
        console.error('Transactions WS connection error:', e);
        setTimeout(connectTransactionsWS, 5000 + Math.random() * 500);
    }
}

function connectStackUpdatesWS() {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}${CONFIG.BASE_PATH}/api/ws/stack-updates`;

    if (state.wsStackUpdates) {
        try { state.wsStackUpdates.close(); } catch (e) { }
        state.wsStackUpdates = null;
    }

    try {
        state.wsStackUpdates = new WebSocket(wsUrl);

        state.wsStackUpdates.onopen = () => {
            state.wsStackUpdatesConnected = true;
            addLog('📡 Stack Updates WS connected', 'success');
        };

        state.wsStackUpdates.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'stack_update') {
                    const strategyId = data.payload?.strategyId || state.activeTab;
                    if (strategyId) {
                        loadStrategyData(strategyId);
                        updateStatus();
                    }
                }
            } catch (e) { }
        };

        state.wsStackUpdates.onclose = () => {
            state.wsStackUpdatesConnected = false;
            addLog('📡 Stack Updates WS disconnected, reconnecting...', 'warning');
            setTimeout(connectStackUpdatesWS, 3000 + Math.random() * 500);
        };

        state.wsStackUpdates.onerror = (error) => {
            console.error('Stack Updates WS error:', error);
        };

    } catch (e) {
        console.error('Stack Updates WS connection error:', e);
        setTimeout(connectStackUpdatesWS, 5000 + Math.random() * 500);
    }
}

function updateOrderBookUI(book) {
    if (!book || !state.activeTab) return;
    const activePanel = document.getElementById(`panel-${state.activeTab}`);
    if (!activePanel) return;
    const bidPrice = activePanel.querySelector('#bidPrice');
    const askPrice = activePanel.querySelector('#askPrice');
    const spread = activePanel.querySelector('#spread');
    const marketFreq = activePanel.querySelector('#marketFreq');
    const bidsEl = activePanel.querySelector('#bids');
    const asksEl = activePanel.querySelector('#asks');
    if (bidPrice) bidPrice.textContent = book.bids?.[0]?.price ? Number(book.bids[0].price).toFixed(2) : '—';
    if (askPrice) askPrice.textContent = book.asks?.[0]?.price ? Number(book.asks[0].price).toFixed(2) : '—';
    if (spread) spread.textContent = book.spread ? Number(book.spread).toFixed(2) : '—';
    if (marketFreq) marketFreq.textContent = book.updateFrequency || 0;
    if (bidsEl) {
        if (book.bids && book.bids.length > 0) {
            bidsEl.innerHTML = book.bids.slice(0, 10).map(b =>
                `<div class="orderbook-row bid">${Number(b.price).toFixed(2)} <span class="volume">${b.quantity || b.volume || 0}</span></div>`
            ).join('');
        } else {
            bidsEl.innerHTML = '<div class="empty-state">No bids</div>';
        }
    }
    if (asksEl) {
        if (book.asks && book.asks.length > 0) {
            asksEl.innerHTML = book.asks.slice(0, 10).map(b =>
                `<div class="orderbook-row ask">${Number(b.price).toFixed(2)} <span class="volume">${b.quantity || b.volume || 0}</span></div>`
            ).join('');
        } else {
            asksEl.innerHTML = '<div class="empty-state">No asks</div>';
        }
    }
}

function handleTransaction(data) {
    const clientOrderId = data.clientOrderId || data.originalClientOrderId;
    if (!clientOrderId) return;
    const status = data.status || data.orderStatus;
    let strategyId = state.activeTab;
    if (!strategyId) {
        for (const strategy of state.strategies) {
            if (clientOrderId.startsWith(strategy.id + '_')) {
                strategyId = strategy.id;
                break;
            }
        }
    }
    if (!strategyId) return;
    loadStrategyData(strategyId);
    const statusMap = {
        '0': 'CREATED',
        '1': 'PARTIAL',
        '2': 'FILLED',
        '4': 'CANCELLED',
        '5': 'MODIFIED',
        '8': 'ERROR',
        '9': 'MODIFYING'
    };
    const statusText = statusMap[status] || status;
    addLog(`📨 [${strategyId}] Order ${clientOrderId.slice(0, 8)}... ${statusText}`, 'info');
}

async function loadStrategies() {
    try {
        const data = await apiCall('/strategies');
        if (data && data.success) {
            state.strategies = data.strategies || [];
            renderTabs();
            return state.strategies;
        }
        return [];
    } catch (e) {
        console.error('Load strategies error:', e);
        return [];
    }
}

function renderTabs() {
    if (!DOM.tabsHeader || !DOM.tabContent) return;
    if (!state.strategies || state.strategies.length === 0) {
        DOM.tabsHeader.innerHTML = '<div class="empty-state">No strategies registered</div>';
        DOM.tabContent.innerHTML = '';
        return;
    }
    let tabsHtml = '', panelsHtml = '';
    state.strategies.forEach((strategy, index) => {
        const isActive = state.strategyStates[strategy.id]?.isRunning || false;
        const isFirst = index === 0;
        const activeClass = isFirst ? 'active' : '';
        tabsHtml += `
            <button class="tab-btn ${activeClass}" data-strategy="${strategy.id}" onclick="switchTab('${strategy.id}')">
                ${strategy.info?.symbol || strategy.id}
                <span class="badge ${isActive ? 'active-badge' : 'inactive-badge'}">${isActive ? '●' : '○'}</span>
            </button>
        `;
        panelsHtml += `
            <div class="tab-panel ${activeClass}" id="panel-${strategy.id}" data-strategy="${strategy.id}">
                ${renderStrategyPanel(strategy)}
            </div>
        `;
    });
    DOM.tabsHeader.innerHTML = tabsHtml;
    DOM.tabContent.innerHTML = panelsHtml;
    if (state.strategies.length > 0 && !state.activeTab) {
        state.activeTab = state.strategies[0].id;
        setTimeout(() => loadStrategyData(state.activeTab), 100);
    }
}

function renderStrategyPanel(strategy) {
    const info = strategy.info || {};
    const isActive = state.strategyStates[strategy.id]?.isRunning || false;
    const symbol = info.symbol || 'SBER';
    const calls = info.metrics?.calls || 0;
    const intents = info.metrics?.intentsGenerated || 0;

    const botRunning = state.isRunning;
    const canStart = !isActive && botRunning;
    const canStop = isActive && botRunning;

    return `
        <div class="strategy-info">
            <div class="info-item"><div class="info-label">ID</div><div class="info-value">${strategy.id}</div></div>
            <div class="info-item"><div class="info-label">Symbol</div><div class="info-value">${symbol}</div></div>
            <div class="info-item"><div class="info-label">Type</div><div class="info-value">${info.type || 'unknown'}</div></div>
            <div class="info-item"><div class="info-label">Status</div><div class="info-value" style="color:${isActive ? '#4ade80' : '#9ca3af'}">${isActive ? 'RUNNING' : 'STOPPED'}</div></div>
            <div class="info-item"><div class="info-label">Calls</div><div class="info-value">${calls}</div></div>
            <div class="info-item"><div class="info-label">Intents</div><div class="info-value">${intents}</div></div>
        </div>
        
        <div class="strategy-controls">
            <button class="btn btn-start btn-sm" id="stratStart-${strategy.id}" onclick="startStrategy('${strategy.id}')" ${canStart ? '' : 'disabled'}>▶ START</button>
            <button class="btn btn-stop btn-sm" id="stratStop-${strategy.id}" onclick="stopStrategy('${strategy.id}')" ${canStop ? '' : 'disabled'}>■ STOP</button>
            <button class="btn btn-cancel btn-sm" id="stratCancel-${strategy.id}" onclick="cancelStrategyOrders('${strategy.id}')" ${isActive ? '' : 'disabled'}>✕ CANCEL</button>
            <button class="btn btn-refresh btn-sm" onclick="refreshStrategy('${strategy.id}')">⟳ REFRESH</button>
        </div>
        
        <div class="main-grid">
            <div class="column">
                <section class="card">
                    <div class="card-title">📈 MARKET DATA <span id="marketSymbol">${symbol}</span></div>
                    <div class="market-prices">
                        <div class="price-item">
                            <span class="price-label">Bid</span>
                            <span class="price-value green" id="bidPrice">—</span>
                        </div>
                        <div class="price-item">
                            <span class="price-label">Ask</span>
                            <span class="price-value red" id="askPrice">—</span>
                        </div>
                        <div class="price-item">
                            <span class="price-label">Spread</span>
                            <span class="price-value blue" id="spread">—</span>
                        </div>
                    </div>
                    <div class="orderbook">
                        <div class="orderbook-column">
                            <div class="orderbook-title bids">BIDS</div>
                            <div id="bids" class="orderbook-list"></div>
                        </div>
                        <div class="orderbook-column">
                            <div class="orderbook-title asks">ASKS</div>
                            <div id="asks" class="orderbook-list"></div>
                        </div>
                    </div>
                    <div style="margin-top:8px;font-size:12px;color:var(--gray);">
                        Updates/s: <span id="marketFreq">0</span>
                    </div>
                </section>
            </div>
            <div class="column">
                <section class="card">
                    <div class="card-title">🟢 ACTIVE ORDERS <span class="count" id="activeCount-${strategy.id}">(0)</span></div>
                    <div class="order-list" id="activeOrders-${strategy.id}">
                        <div class="empty-state">No active orders</div>
                    </div>
                </section>
                <section class="card">
                    <div class="card-title">📜 ORDER HISTORY <span class="count" id="historyCount-${strategy.id}">(0)</span></div>
                    <div class="order-list" id="orderHistory-${strategy.id}">
                        <div class="empty-state">No history yet</div>
                    </div>
                </section>
                <section class="card">
                    <div class="card-title">🛡️ RISK STATUS</div>
                    <div class="risk-grid">
                        <div class="risk-item">
                            <span class="risk-label">Position</span>
                            <span class="risk-value" id="riskPosition">0</span>
                        </div>
                        <div class="risk-item">
                            <span class="risk-label">Daily P&L</span>
                            <span class="risk-value" id="riskPnL">0</span>
                        </div>
                        <div class="risk-item">
                            <span class="risk-label">Circuit Breaker</span>
                            <span class="risk-value" id="riskCircuit">✅ Closed</span>
                        </div>
                        <div class="risk-item">
                            <span class="risk-label">Daily Orders</span>
                            <span class="risk-value" id="riskDailyOrders">0</span>
                        </div>
                    </div>
                </section>
            </div>
        </div>
    `;
}

function switchTab(strategyId) {
    state.activeTab = strategyId;
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.strategy === strategyId);
    });
    document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.classList.toggle('active', panel.dataset.strategy === strategyId);
    });
    if (strategyId) {
        loadStrategyData(strategyId);
    }
}

async function loadStrategyData(strategyId) {
    try {
        const ordersResp = await apiCall(`/strategies/${strategyId}/orders`);
        const activeOrders = ordersResp?.orders || [];
        state.activeOrders = activeOrders;

        const activeContainer = document.getElementById(`activeOrders-${strategyId}`);
        const activeCount = document.getElementById(`activeCount-${strategyId}`);

        if (activeContainer) {
            activeCount.textContent = `(${activeOrders.length})`;
            if (activeOrders.length === 0) {
                activeContainer.innerHTML = '<div class="empty-state">No active orders</div>';
            } else {
                activeContainer.innerHTML = activeOrders.map(o => {
                    const statusMap = {
                        '0': 'created',
                        '5': 'active',
                        'pending': 'pending',
                        'active': 'active',
                        'filled': 'filled',
                        'cancelled': 'cancelled',
                        'error': 'error',
                        'replaced': 'replaced'
                    };
                    const cls = statusMap[o.status] || statusMap[String(o.status)] || 'pending';
                    const price = o.price ? Number(o.price).toFixed(2) : '—';
                    return `
                        <div class="order-item">
                            <span class="id">${o.client_order_id ? o.client_order_id.substring(0, 12) + '...' : '—'}</span>
                            <span class="price">${price}</span>
                            <span class="status ${cls}">${o.status || 'PENDING'}</span>
                        </div>
                    `;
                }).join('');
            }
        }

        const historyResp = await apiCall(`/strategies/${strategyId}/history?limit=20`);
        const historyOrders = historyResp?.orders || [];
        state.historyOrders = historyOrders;

        const historyContainer = document.getElementById(`orderHistory-${strategyId}`);
        const historyCount = document.getElementById(`historyCount-${strategyId}`);

        if (historyContainer) {
            historyCount.textContent = `(${historyOrders.length})`;
            if (historyOrders.length === 0) {
                historyContainer.innerHTML = '<div class="empty-state">No history yet</div>';
            } else {
                historyContainer.innerHTML = historyOrders.map(o => {
                    const statusMap = {
                        '0': 'created',
                        '5': 'active',
                        'pending': 'pending',
                        'active': 'active',
                        'filled': 'filled',
                        'cancelled': 'cancelled',
                        'error': 'error',
                        'replaced': 'replaced'
                    };
                    const cls = statusMap[o.status] || statusMap[String(o.status)] || 'pending';
                    const price = o.price ? Number(o.price).toFixed(2) : '—';
                    return `
                        <div class="order-item">
                            <span class="id">${o.client_order_id ? o.client_order_id.substring(0, 12) + '...' : '—'}</span>
                            <span class="price">${price}</span>
                            <span class="status ${cls}">${o.status || 'PENDING'}</span>
                            <span style="font-size:10px;color:#6b7280;">${new Date(o.created_at).toLocaleTimeString()}</span>
                        </div>
                    `;
                }).join('');
            }
        }

        updateGlobalCounts();

    } catch (e) {
        console.error(`Error loading data for ${strategyId}:`, e);
    }
}

function updateGlobalCounts() {
    let totalActive = 0;
    let totalHistory = 0;

    state.strategies.forEach(strategy => {
        const container = document.getElementById(`activeOrders-${strategy.id}`);
        const historyContainer = document.getElementById(`orderHistory-${strategy.id}`);
        if (container) {
            const items = container.querySelectorAll('.order-item');
            totalActive += items.length;
        }
        if (historyContainer) {
            const items = historyContainer.querySelectorAll('.order-item');
            totalHistory += items.length;
        }
    });

    if (DOM.statActiveOrders) DOM.statActiveOrders.textContent = totalActive;
    if (DOM.statHistory) DOM.statHistory.textContent = totalHistory;
}

async function updateStatus() {
    try {
        const data = await apiCall('/status');
        if (!data) return;

        const isRunning = data.isRunning || false;
        state.isRunning = isRunning;
        const isHealthy = data.isHealthy || false;

        if (DOM.statusBadge) {
            if (isRunning) {
                DOM.statusBadge.textContent = '● RUNNING';
                DOM.statusBadge.className = 'status-badge running';
            } else if (isHealthy) {
                DOM.statusBadge.textContent = '● IDLE';
                DOM.statusBadge.className = 'status-badge idle';
            } else {
                DOM.statusBadge.textContent = '● STOPPED';
                DOM.statusBadge.className = 'status-badge stopped';
            }
        }

        // Глобальные кнопки
        if (DOM.btnStart) DOM.btnStart.disabled = isRunning;
        if (DOM.btnStop) DOM.btnStop.disabled = !isRunning;
        if (DOM.btnCancel) DOM.btnCancel.disabled = !isRunning;

        if (DOM.uptime && data.uptime) {
            state.uptimeSeconds = data.uptime;
            DOM.uptime.textContent = '⏱ ' + Math.floor(data.uptime) + 's';
        }

        // ============================================================
        // ОБНОВЛЯЕМ СТАТУС СТРАТЕГИЙ
        // ============================================================
        const om = data.orderManager || {};
        const stacks = om.stacks || {};

        const strategiesData = await apiCall('/strategies');
        const strategiesInfo = strategiesData?.success ? strategiesData.strategies : [];

        for (const strategy of state.strategies) {
            if (!state.strategyStates[strategy.id]) {
                state.strategyStates[strategy.id] = { isRunning: false };
            }

            const stack = stacks[strategy.id];
            const hasActive = stack ? (stack.activeCount || 0) > 0 : false;
            const hasPending = stack ? (stack.pendingCount || 0) > 0 : false;

            const strategyInfo = strategiesInfo.find(s => s.id === strategy.id);
            const isStrategyActive = strategyInfo?.isActive || false;

            const isRunningState = hasActive || hasPending || isStrategyActive;
            state.strategyStates[strategy.id].isRunning = isRunningState;

            // Обновляем кнопки стратегии
            const startBtn = document.getElementById(`stratStart-${strategy.id}`);
            const stopBtn = document.getElementById(`stratStop-${strategy.id}`);
            const cancelBtn = document.getElementById(`stratCancel-${strategy.id}`);

            if (startBtn) {
                startBtn.disabled = !(isRunning && !isRunningState);
            }
            if (stopBtn) {
                stopBtn.disabled = !(isRunning && isRunningState);
            }
            if (cancelBtn) {
                cancelBtn.disabled = !(isRunning && isRunningState);
            }

            // Обновляем статус вкладки
            const tabBtn = document.querySelector(`.tab-btn[data-strategy="${strategy.id}"]`);
            if (tabBtn) {
                const badge = tabBtn.querySelector('.badge');
                if (badge) {
                    badge.textContent = isRunningState ? '●' : '○';
                    badge.className = `badge ${isRunningState ? 'active-badge' : 'inactive-badge'}`;
                }
            }

            // Обновляем информацию о стратегии в панели
            const panel = document.getElementById(`panel-${strategy.id}`);
            if (panel) {
                const statusEl = panel.querySelector('.strategy-info .info-value[style]');
                if (statusEl) {
                    statusEl.textContent = isRunningState ? 'RUNNING' : 'STOPPED';
                    statusEl.style.color = isRunningState ? '#4ade80' : '#9ca3af';
                }

                const infoItems = panel.querySelectorAll('.strategy-info .info-item');
                for (const item of infoItems) {
                    const label = item.querySelector('.info-label');
                    if (label && label.textContent === 'Calls') {
                        const value = item.querySelector('.info-value');
                        if (value) {
                            const calls = strategyInfo?.info?.metrics?.calls || 0;
                            value.textContent = calls;
                        }
                    }
                    if (label && label.textContent === 'Intents') {
                        const value = item.querySelector('.info-value');
                        if (value) {
                            const intents = strategyInfo?.info?.metrics?.intentsGenerated || 0;
                            value.textContent = intents;
                        }
                    }
                }
            }
        }

        let activeCount = 0, pendingCount = 0, historyCount = 0;
        for (const [id, stack] of Object.entries(stacks)) {
            activeCount += stack.activeCount || 0;
            pendingCount += stack.pendingCount || 0;
            historyCount += stack.historyCount || 0;
        }

        if (DOM.statStrategies) DOM.statStrategies.textContent = Object.keys(stacks).length || 0;
        if (DOM.statPending) DOM.statPending.textContent = pendingCount;
        if (DOM.statQueue) DOM.statQueue.textContent = data.executionQueue?.queueSizes?.TOTAL || 0;

        updateConnectionsUI();

        if (DOM.authStatus) {
            const authData = data.auth || {};
            const isValid = authData.isTokenValid || false;
            const expiresIn = authData.expiresInHours || '?';
            DOM.authStatus.textContent = isValid ? `🟢 Valid (${expiresIn}h)` : '🔴 Invalid';
            DOM.authStatus.className = 'conn-value ' + (isValid ? 'green' : 'red');
        }

        const risk = data.riskManager?.state || {};
        if (DOM.riskPosition) {
            DOM.riskPosition.textContent = risk.totalPosition || 0;
            DOM.riskPosition.className = 'risk-value ' + (risk.totalPosition > 0 ? 'green' : risk.totalPosition < 0 ? 'red' : '');
        }

        if (DOM.riskPnL) {
            const pnl = risk.dailyPnl || 0;
            DOM.riskPnL.textContent = pnl.toFixed(2);
            DOM.riskPnL.className = 'risk-value ' + (pnl > 0 ? 'green' : pnl < 0 ? 'red' : '');
        }

        if (DOM.riskCircuit) {
            DOM.riskCircuit.textContent = risk.isCircuitBreakerOpen ? '🔴 OPEN' : '✅ Closed';
            DOM.riskCircuit.className = 'risk-value ' + (risk.isCircuitBreakerOpen ? 'red' : 'green');
        }

        if (DOM.riskDailyOrders) {
            DOM.riskDailyOrders.textContent = risk.dailyOrders || 0;
        }

        if (DOM.timestamp) {
            DOM.timestamp.textContent = 'Last update: ' + new Date().toLocaleTimeString();
        }

    } catch (e) {
        console.error('Status update error:', e);
    }
}

// ============================================================
// GLOBAL CONTROLS
// ============================================================
async function startBot() {
    try {
        const data = await apiCall('/start', { method: 'POST' });
        if (data && data.success) {
            addLog('Bot started', 'success');
            await updateStatus();
        } else {
            addLog('Start failed', 'error');
        }
    } catch (e) {
        addLog('Start error: ' + e.message, 'error');
    }
}

async function stopBot() {
    try {
        const data = await apiCall('/stop', { method: 'POST' });
        if (data && data.success) {
            addLog('Bot stopped', 'info');
            await updateStatus();
        } else {
            addLog('Stop failed', 'error');
        }
    } catch (e) {
        addLog('Stop error: ' + e.message, 'error');
    }
}

async function cancelAllOrders() {
    try {
        const data = await apiCall('/cancel', { method: 'POST' });
        if (data && data.success) {
            addLog(`Cancelled ${data.results?.length || 0} orders`, 'success');
            await updateStatus();
        } else {
            addLog('Cancel all failed', 'error');
        }
    } catch (e) {
        addLog('Cancel all error: ' + e.message, 'error');
    }
}

async function refreshAll() {
    addLog('Refreshing all...', 'info');
    await updateUI();
    addLog('Refresh complete', 'success');
}

// ============================================================
// STRATEGY CONTROLS
// ============================================================
async function startStrategy(strategyId) {
    try {
        await apiCall(`/strategies/${strategyId}/start`, { method: 'POST' });
        addLog(`Strategy ${strategyId} started`, 'success');
        await updateStatus();
        setTimeout(() => loadStrategyData(strategyId), 500);
    } catch (e) {
        addLog(`Failed to start ${strategyId}: ${e.message}`, 'error');
    }
}

async function stopStrategy(strategyId) {
    try {
        await apiCall(`/strategies/${strategyId}/stop`, { method: 'POST' });
        addLog(`Strategy ${strategyId} stopped`, 'warning');
        await updateStatus();
        setTimeout(() => loadStrategyData(strategyId), 500);
    } catch (e) {
        addLog(`Failed to stop ${strategyId}: ${e.message}`, 'error');
    }
}

async function cancelStrategyOrders(strategyId) {
    try {
        // Используем общий эндпоинт /cancel, но передаем strategyId
        const data = await apiCall('/cancel', {
            method: 'POST',
            body: JSON.stringify({ strategyId: strategyId })
        });
        if (data && data.success) {
            addLog(`Cancelled ${data.results?.length || 0} orders for ${strategyId}`, 'success');
            await updateStatus();
            setTimeout(() => loadStrategyData(strategyId), 500);
        } else {
            addLog(`Cancel failed for ${strategyId}`, 'error');
        }
    } catch (e) {
        addLog(`Cancel error for ${strategyId}: ${e.message}`, 'error');
    }
}

async function refreshStrategy(strategyId) {
    addLog(`Refreshing ${strategyId}...`, 'info');
    await loadStrategyData(strategyId);
    await updateStatus();
    addLog(`Refresh ${strategyId} complete`, 'success');
}

// ============================================================
// UI UPDATE
// ============================================================
async function updateUI() {
    try {
        await loadStrategies();
        await updateStatus();
        if (state.activeTab) {
            await loadStrategyData(state.activeTab);
        }
        updateGlobalCounts();
    } catch (e) {
        console.error('Update error:', e);
    }
}

function refreshData() {
    addLog('Manual refresh', 'info');
    updateUI();
}

function addLog(msg, type = 'info') {
    const logEl = DOM.log;
    if (!logEl) return;
    const line = document.createElement('div');
    line.className = 'log-line ' + type;
    line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
    if (logEl.children.length > CONFIG.MAX_LOG_LINES) {
        logEl.removeChild(logEl.firstChild);
    }
}

function init() {
    cacheDomRefs();

    addLog('Trading Bot v4.0 ready', 'info');
    addLog('Loading data...', 'info');

    connectOrderBookWS();
    connectTransactionsWS();
    connectStackUpdatesWS();

    updateUI();

    setTimeout(() => {
        updateConnectionsUI();
    }, 1000);

    setInterval(() => {
        if (DOM.uptime && state.uptimeSeconds > 0) {
            state.uptimeSeconds += 1;
            DOM.uptime.textContent = '⏱ ' + Math.floor(state.uptimeSeconds) + 's';
        }
    }, 1000);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}