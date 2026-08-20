const fs = require('fs');
const path = require('path');
const config = require('../config');

const LOG_DIR = path.join(__dirname, '../../logs');
try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o755 });
    try { fs.accessSync(LOG_DIR, fs.constants.W_OK); } catch (err) { fs.chmodSync(LOG_DIR, 0o755); }
} catch (err) { console.error(`[Logger] Failed to create log directory: ${err.message}`); }

const LOG_FILE = path.join(LOG_DIR, `bot_${new Date().toISOString().replace(/[:.]/g, '').slice(0, 14)}.log`);
let logStream;
try { logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' }); } catch (err) { logStream = process.stdout; }

const logHistory = [];
const MAX_LOG_HISTORY = 200;

const COLORS = {
    green: '\x1b[0;32m', red: '\x1b[0;31m', blue: '\x1b[0;34m',
    yellow: '\x1b[1;33m', cyan: '\x1b[0;36m', magenta: '\x1b[0;35m',
    gray: '\x1b[0;90m', white: '\x1b[0;37m', nc: '\x1b[0m',
};

const LOG_LEVELS = { NONE: 0, ERROR: 1, WARN: 2, INFO: 3, LOG: 4, DEBUG: 5, ALL: 6 };
let currentLevel = LOG_LEVELS[config.logLevel] || LOG_LEVELS.ALL;
let disabled = config.logDisabled || false;
let disableWsLogs = false, disableStats = false;

function shouldLog(level) { return !disabled && currentLevel >= level; }
function logToFile(msg) { try { logStream.write(`[${new Date().toISOString()}] ${msg}\n`); } catch (err) {} }
function addToHistory(level, msg) { logHistory.push({ timestamp: new Date(), level, message: msg }); if (logHistory.length > MAX_LOG_HISTORY) logHistory.shift(); }
function getLogs(limit = 50) { return logHistory.slice(-limit); }

function setLevel(level) {
    const upper = level.toUpperCase();
    if (LOG_LEVELS[upper] !== undefined) { currentLevel = LOG_LEVELS[upper]; console.log(`📊 Log level set to: ${upper}`); logToFile(`[CONFIG] Log level set to: ${upper}`); }
}
function getLevel() { return currentLevel; }
function getLevelName() { return Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k] === currentLevel) || 'UNKNOWN'; }
function disableAll() { disabled = true; console.log('🔇 All logging disabled'); }
function enableAll() { disabled = false; console.log('🔊 All logging enabled'); }
function setWsLogsDisabled(state) { disableWsLogs = state; }
function setStatsDisabled(state) { disableStats = state; }
function getStatus() { return { disabled, level: currentLevel, levelName: getLevelName(), disableWsLogs, disableStats, logFile: LOG_FILE, historySize: logHistory.length }; }

function log(msg) { if (!shouldLog(LOG_LEVELS.LOG)) return; console.log(`${COLORS.blue}[${new Date().toTimeString().slice(0, 8)}]${COLORS.nc} ${msg}`); logToFile(msg); addToHistory('LOG', msg); }
function ok(msg) { if (!shouldLog(LOG_LEVELS.INFO)) return; console.log(`${COLORS.green}[✓]${COLORS.nc} ${msg}`); logToFile(`[OK] ${msg}`); addToHistory('INFO', msg); }
function err(msg) { if (!shouldLog(LOG_LEVELS.ERROR)) return; console.log(`${COLORS.red}[✗]${COLORS.nc} ${msg}`); logToFile(`[ERROR] ${msg}`); addToHistory('ERROR', msg); }
function info(msg) { if (!shouldLog(LOG_LEVELS.INFO)) return; console.log(`${COLORS.yellow}[i]${COLORS.nc} ${msg}`); logToFile(`[INFO] ${msg}`); addToHistory('INFO', msg); }
function warn(msg) { if (!shouldLog(LOG_LEVELS.WARN)) return; console.log(`${COLORS.magenta}[⚠]${COLORS.nc} ${msg}`); logToFile(`[WARN] ${msg}`); addToHistory('WARN', msg); }
function stat(msg) { if (!shouldLog(LOG_LEVELS.INFO) || disableStats) return; console.log(`${COLORS.cyan}[📊]${COLORS.nc} ${msg}`); logToFile(`[STAT] ${msg}`); addToHistory('STAT', msg); }
function wsLog(msg) { if (!shouldLog(LOG_LEVELS.DEBUG) || disableWsLogs) return; console.log(`${COLORS.gray}[WS]${COLORS.nc} ${msg}`); logToFile(`[WS] ${msg}`); addToHistory('DEBUG', msg); }
function debug(msg) { if (!shouldLog(LOG_LEVELS.DEBUG)) return; console.log(`${COLORS.gray}[DEBUG]${COLORS.nc} ${msg}`); logToFile(`[DEBUG] ${msg}`); addToHistory('DEBUG', msg); }

module.exports = {
    log, ok, err, info, warn, stat, wsLog, debug,
    logToFile, logStream, logHistory, getLogs,
    setLevel, getLevel, getLevelName, disableAll, enableAll,
    setWsLogsDisabled, setStatsDisabled, getStatus, LOG_LEVELS
};
