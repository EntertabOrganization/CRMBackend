ALTER TABLE commerce_orders ADD COLUMN refunded_amount NUMERIC(24,6) NOT NULL DEFAULT 0;
ALTER TABLE commerce_orders ADD COLUMN fulfillment_status TEXT NOT NULL DEFAULT 'UNFULFILLED';
ALTER TABLE commerce_orders DROP CONSTRAINT commerce_order_payment_projection;
ALTER TABLE commerce_orders ADD CONSTRAINT commerce_order_payment_projection CHECK(paid_amount>=0 AND paid_amount<=total AND refunded_amount>=0 AND payment_status IN ('UNPAID','PARTIALLY_PAID','PAID','PARTIALLY_REFUNDED','REFUNDED'));
ALTER TABLE commerce_orders ADD CONSTRAINT commerce_order_fulfillment_projection CHECK(fulfillment_status IN ('UNFULFILLED','PARTIALLY_FULFILLED','FULFILLED','PARTIALLY_RETURNED','RETURNED'));
-- Forward backfill from delivered and accepted Return evidence. Original Order
-- snapshots remain untouched; workers maintain these independent projections.
UPDATE commerce_orders o SET fulfillment_status=CASE
 WHEN EXISTS(SELECT 1 FROM commerce_return_lines l JOIN commerce_returns r ON r.workspace_id=l.workspace_id AND r.id=l.return_id WHERE l.workspace_id=o.workspace_id AND l.order_id=o.id AND r.status='COMPLETED' AND l.disposition<>'REJECT') THEN 'PARTIALLY_RETURNED'
 WHEN o.status='COMPLETED' THEN 'FULFILLED'
 WHEN EXISTS(SELECT 1 FROM commerce_shipments s WHERE s.workspace_id=o.workspace_id AND s.order_id=o.id AND s.delivered_at IS NOT NULL) THEN 'PARTIALLY_FULFILLED'
 ELSE 'UNFULFILLED' END;
