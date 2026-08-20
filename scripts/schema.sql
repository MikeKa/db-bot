-- TRADING BOT v4.0 - POSTGRESQL SCHEMA

CREATE TABLE IF NOT EXISTS strategies (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(50) NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    class_code VARCHAR(20) NOT NULL,
    config JSONB NOT NULL DEFAULT '{}',
    status VARCHAR(20) DEFAULT 'INACTIVE',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_started_at TIMESTAMP WITH TIME ZONE,
    last_stopped_at TIMESTAMP WITH TIME ZONE,
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_strategies_symbol ON strategies(symbol);
CREATE INDEX IF NOT EXISTS idx_strategies_status ON strategies(status);

CREATE TABLE IF NOT EXISTS instruments (
    id SERIAL PRIMARY KEY,
    ticker VARCHAR(20) NOT NULL UNIQUE,
    class_code VARCHAR(20) NOT NULL,
    name VARCHAR(100),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS orders (
    id BIGSERIAL PRIMARY KEY,
    client_order_id VARCHAR(100) NOT NULL UNIQUE,
    broker_order_id VARCHAR(100),
    strategy_id VARCHAR(50) REFERENCES strategies(id) ON DELETE SET NULL,
    instrument_id INTEGER REFERENCES instruments(id) ON DELETE SET NULL,
    side VARCHAR(10) NOT NULL,
    order_type VARCHAR(20) NOT NULL DEFAULT 'LIMIT',
    price DECIMAL(20, 8),
    quantity DECIMAL(20, 8) NOT NULL,
    filled_quantity DECIMAL(20, 8) DEFAULT 0,
    remaining_quantity DECIMAL(20, 8),
    status VARCHAR(30) NOT NULL,
    broker_status VARCHAR(10),
    error_message TEXT,
    linked_order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
    replaces_order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
    replaced_by_order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
    role VARCHAR(20),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    confirmed_at TIMESTAMP WITH TIME ZONE,
    filled_at TIMESTAMP WITH TIME ZONE,
    cancelled_at TIMESTAMP WITH TIME ZONE,
    expired_at TIMESTAMP WITH TIME ZONE,
    broker_order_number BIGINT,
    broker_client_code VARCHAR(50),
    broker_execution_id VARCHAR(100),
    broker_transaction_time TIMESTAMP WITH TIME ZONE,
    metadata JSONB DEFAULT '{}',
    raw_broker_response JSONB,
    version INTEGER DEFAULT 1,
    attempts INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    is_ws_confirmed BOOLEAN DEFAULT FALSE,
    is_rest_confirmed BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_orders_client_order_id ON orders(client_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_broker_order_id ON orders(broker_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_strategy_id ON orders(strategy_id);
CREATE INDEX IF NOT EXISTS idx_orders_instrument_id ON orders(instrument_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_is_active ON orders(is_active);

CREATE TABLE IF NOT EXISTS order_status_history (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT REFERENCES orders(id) ON DELETE CASCADE,
    status VARCHAR(30) NOT NULL,
    broker_status VARCHAR(10),
    price DECIMAL(20, 8),
    quantity DECIMAL(20, 8),
    filled_quantity DECIMAL(20, 8),
    remaining_quantity DECIMAL(20, 8),
    error_message TEXT,
    raw_data JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    source VARCHAR(20)
);

CREATE INDEX IF NOT EXISTS idx_order_status_history_order_id ON order_status_history(order_id);

CREATE TABLE IF NOT EXISTS logs (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    level VARCHAR(10) NOT NULL,
    service VARCHAR(50),
    strategy_id VARCHAR(50) REFERENCES strategies(id) ON DELETE SET NULL,
    order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
    message TEXT NOT NULL,
    context JSONB,
    source_file VARCHAR(200),
    source_line INTEGER,
    trace_id VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
CREATE INDEX IF NOT EXISTS idx_logs_strategy_id ON logs(strategy_id);
CREATE INDEX IF NOT EXISTS idx_logs_order_id ON logs(order_id);

INSERT INTO strategies (id, name, type, symbol, class_code, config, status)
VALUES 
    ('sber_bid', 'SBER BID Strategy', 'constant-bid', 'SBER', 'TQBR', '{"offsetPercent": 1, "quantity": 1}', 'INACTIVE')
ON CONFLICT (id) DO NOTHING;

INSERT INTO instruments (ticker, class_code, name, is_active)
VALUES 
    ('SBER', 'TQBR', 'Сбербанк', true)
ON CONFLICT (ticker) DO NOTHING;
