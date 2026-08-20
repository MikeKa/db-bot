const db = require('./index');

class OrderDAO {
    async createOrder(orderData) {
        const query = `
            INSERT INTO orders (
                client_order_id, broker_order_id, strategy_id, instrument_id,
                side, order_type, price, quantity, filled_quantity, remaining_quantity,
                status, broker_status, role, metadata, raw_broker_response,
                broker_order_number, broker_client_code, broker_execution_id,
                broker_transaction_time, is_active, is_ws_confirmed, is_rest_confirmed
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
            ) ON CONFLICT (client_order_id) DO UPDATE SET
                broker_order_id = EXCLUDED.broker_order_id,
                status = EXCLUDED.status,
                broker_status = EXCLUDED.broker_status,
                updated_at = CURRENT_TIMESTAMP,
                version = orders.version + 1,
                filled_quantity = EXCLUDED.filled_quantity,
                remaining_quantity = EXCLUDED.remaining_quantity,
                is_active = EXCLUDED.is_active
            RETURNING *
        `;

        const values = [
            orderData.clientOrderId,
            orderData.brokerOrderId,
            orderData.strategyId,
            orderData.instrumentId,
            orderData.side,
            orderData.orderType || 'LIMIT',
            orderData.price,
            orderData.quantity,
            orderData.filledQuantity || 0,
            orderData.remainingQuantity || orderData.quantity,
            orderData.status || 'PENDING',
            orderData.brokerStatus,
            orderData.role,
            orderData.metadata || {},
            orderData.rawBrokerResponse,
            orderData.brokerOrderNumber,
            orderData.brokerClientCode,
            orderData.brokerExecutionId,
            orderData.brokerTransactionTime,
            orderData.isActive !== false,
            orderData.isWsConfirmed || false,
            orderData.isRestConfirmed || false,
        ];

        const result = await db.query(query, values);
        return result.rows[0];
    }

    async getOrderByClientId(clientOrderId) {
        const result = await db.query('SELECT * FROM orders WHERE client_order_id = $1', [clientOrderId]);
        return result.rows[0] || null;
    }

    async getOrderByBrokerId(brokerOrderId) {
        const result = await db.query('SELECT * FROM orders WHERE broker_order_id = $1', [brokerOrderId]);
        return result.rows[0] || null;
    }

    async getAllActiveOrders() {
        const result = await db.query(`
            SELECT * FROM orders 
            WHERE is_active = true 
            AND status IN ('PENDING', 'ACTIVE', 'PARTIALLY_FILLED', 'CREATED', 'MODIFIED', 'REPLACED')
            ORDER BY created_at DESC
        `);
        return result.rows;
    }

    async getActiveOrdersForStrategy(strategyId) {
        const result = await db.query(`
            SELECT * FROM orders 
            WHERE strategy_id = $1 
            AND is_active = true 
            AND status IN ('PENDING', 'ACTIVE', 'PARTIALLY_FILLED', 'CREATED', 'MODIFIED', 'REPLACED')
            ORDER BY created_at DESC
        `, [strategyId]);
        return result.rows;
    }

    async updateOrderStatus(clientOrderId, status, brokerStatus = null, data = null) {
        const isFinal = ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'REPLACING'].includes(status);
        const isFilled = status === 'FILLED';
        const isCancelled = status === 'CANCELLED' || status === 'REJECTED' || status === 'EXPIRED';
        const query = `
            UPDATE orders 
            SET status = $1,
                broker_status = COALESCE($2, broker_status),
                updated_at = CURRENT_TIMESTAMP,
                version = version + 1,
                raw_broker_response = COALESCE($3, raw_broker_response),
                is_ws_confirmed = CASE WHEN $4 THEN true ELSE is_ws_confirmed END,
                is_rest_confirmed = CASE WHEN $5 THEN true ELSE is_rest_confirmed END,
                confirmed_at = CASE WHEN $6 THEN CURRENT_TIMESTAMP ELSE confirmed_at END,
                filled_at = CASE WHEN $7 THEN CURRENT_TIMESTAMP ELSE filled_at END,
                cancelled_at = CASE WHEN $8 THEN CURRENT_TIMESTAMP ELSE cancelled_at END,
                is_active = CASE WHEN $9 THEN false ELSE is_active END,
                filled_quantity = COALESCE($10, filled_quantity),
                remaining_quantity = COALESCE($11, remaining_quantity),
                price = COALESCE($12, price)
            WHERE client_order_id = $13
            RETURNING *
        `;
        const values = [
            status,
            brokerStatus,
            data ? JSON.stringify(data) : null,
            true,
            true,
            status === 'ACTIVE' || status === 'CONFIRMED',
            isFilled,
            isCancelled,
            isFinal,
            data?.filledQuantity || null,
            data?.remainingQuantity || null,
            data?.price || null,
            clientOrderId
        ];
        const result = await db.query(query, values);
        return result.rows[0] || null;
    }

    async addStatusHistory(orderId, status, brokerStatus, data, source = 'SYSTEM') {
        const query = `
            INSERT INTO order_status_history (
                order_id, status, broker_status, price, quantity,
                filled_quantity, remaining_quantity, error_message,
                raw_data, source
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `;
        const values = [
            orderId, status, brokerStatus,
            data?.price || null, data?.quantity || null,
            data?.filledQuantity || null, data?.remainingQuantity || null,
            data?.errorMessage || null,
            data ? JSON.stringify(data) : null,
            source
        ];
        await db.query(query, values);
    }

    async addLog(logData) {
        const query = `
            INSERT INTO logs (
                level, service, strategy_id, order_id, message,
                context, source_file, source_line, trace_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id
        `;
        const values = [
            logData.level, logData.service,
            logData.strategyId, logData.orderId,
            logData.message,
            logData.context ? JSON.stringify(logData.context) : null,
            logData.sourceFile, logData.sourceLine, logData.traceId
        ];
        const result = await db.query(query, values);
        return result.rows[0]?.id || null;
    }

    async searchOrders(filters) {
        let query = 'SELECT * FROM orders WHERE 1=1';
        const values = [];
        let paramIndex = 1;
        if (filters.strategyId) {
            query += ` AND strategy_id = $${paramIndex++}`;
            values.push(filters.strategyId);
        }
        if (filters.instrumentId) {
            query += ` AND instrument_id = $${paramIndex++}`;
            values.push(filters.instrumentId);
        }
        if (filters.status) {
            query += ` AND status = $${paramIndex++}`;
            values.push(filters.status);
        }
        if (filters.side) {
            query += ` AND side = $${paramIndex++}`;
            values.push(filters.side);
        }
        if (filters.role) {
            query += ` AND role = $${paramIndex++}`;
            values.push(filters.role);
        }
        if (filters.fromDate) {
            query += ` AND created_at >= $${paramIndex++}`;
            values.push(filters.fromDate);
        }
        if (filters.toDate) {
            query += ` AND created_at <= $${paramIndex++}`;
            values.push(filters.toDate);
        }
        if (filters.isActive !== undefined) {
            query += ` AND is_active = $${paramIndex++}`;
            values.push(filters.isActive);
        }
        if (filters.limit) {
            query += ` LIMIT $${paramIndex++}`;
            values.push(filters.limit);
        }
        if (filters.offset) {
            query += ` OFFSET $${paramIndex++}`;
            values.push(filters.offset);
        }
        const result = await db.query(query, values);
        return result.rows;
    }

    async getStrategyStats(strategyId) {
        const query = `
            SELECT 
                COUNT(*) as total_orders,
                COUNT(CASE WHEN status = 'FILLED' THEN 1 END) as filled_orders,
                COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) as cancelled_orders,
                COUNT(CASE WHEN status = 'ERROR' OR status = 'REJECTED' THEN 1 END) as error_orders,
                COUNT(CASE WHEN is_active = true AND status IN ('PENDING', 'ACTIVE', 'PARTIALLY_FILLED') THEN 1 END) as active_orders,
                COALESCE(SUM(filled_quantity), 0) as total_filled_quantity,
                COALESCE(AVG(price), 0) as avg_price
            FROM orders WHERE strategy_id = $1
        `;
        const result = await db.query(query, [strategyId]);
        return result.rows[0] || null;
    }
}

module.exports = new OrderDAO();