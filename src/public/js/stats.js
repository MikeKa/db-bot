const CONFIG = { BASE_PATH: window.location.pathname.startsWith('/bot') ? '/bot' : '', UPDATE_INTERVAL: 2000 };
const API = { get BASE_URL() { return CONFIG.BASE_PATH + '/api'; } };

async function apiCall(endpoint) {
    try { const resp = await fetch(API.BASE_URL + endpoint); const data = await resp.json(); if (!resp.ok) throw new Error(data.error); return data; }
    catch (e) { console.error('API Error:', e.message); return null; }
}

async function updateStats() {
    try {
        const data = await apiCall('/stats');
        if (!data) return;
        document.getElementById('totalStrategies').textContent = data.totalStrategies || 0;
        document.getElementById('activeStrategies').textContent = data.activeStrategies || 0;
        document.getElementById('uptime').textContent = Math.floor(data.uptime || 0) + 's';
        document.getElementById('memory').textContent = Math.round((data.memory?.heapUsed || 0) / 1024 / 1024) + 'MB';
        document.getElementById('timestamp').textContent = 'Last update: ' + new Date().toLocaleTimeString();
    } catch (e) { console.error('Update error:', e); }
}

function init() { updateStats(); setInterval(updateStats, CONFIG.UPDATE_INTERVAL); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
