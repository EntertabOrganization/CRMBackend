-- Cover the referencing side of the shared Payment and owning Order foreign keys.
CREATE INDEX commerce_dispute_payment_fk ON commerce_payment_disputes(payment_id);
CREATE INDEX commerce_dispute_order_fk ON commerce_payment_disputes(workspace_id,store_id,order_id);
