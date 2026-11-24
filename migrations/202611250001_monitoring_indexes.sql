-- Composite index to accelerate routing-dimension aggregations over time windows.
CREATE INDEX IF NOT EXISTS idx_request_logs_route_created
    ON request_logs (route_rule_id, created_at DESC);
