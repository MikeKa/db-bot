const { Pool } = require('pg');
const config = require('../config');

class Database {
    constructor() {
        this.pool = null;
        this._isConnected = false;
    }

    async connect() {
        if (this._isConnected) return;
        this.pool = new Pool({
            host: config.db.host || 'localhost',
            port: config.db.port || 5432,
            database: config.db.database || 'trading_bot',
            user: config.db.user || 'trading_bot',
            password: config.db.password,
            max: config.db.poolSize || 20,
            idleTimeoutMillis: config.db.idleTimeout || 30000,
            connectionTimeoutMillis: config.db.connectionTimeout || 5000,
        });
        this.pool.on('error', (err) => console.error('[DB] Unexpected error:', err.message));
        try {
            await this.pool.query('SELECT 1');
            this._isConnected = true;
            console.log('✅ Database connected');
        } catch (err) {
            console.error('❌ Database connection failed:', err.message);
            throw err;
        }
    }

    async disconnect() {
        if (this.pool) {
            await this.pool.end();
            this._isConnected = false;
            console.log('🔌 Database disconnected');
        }
    }

    async query(sql, params) {
        if (!this._isConnected) throw new Error('Database not connected');
        return this.pool.query(sql, params);
    }

    async transaction(callback) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await callback(client);
            await client.query('COMMIT');
            return result;
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    get isConnected() {
        return this._isConnected;
    }
}

module.exports = new Database();