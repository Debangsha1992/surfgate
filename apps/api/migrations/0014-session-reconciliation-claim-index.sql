-- surfgate:online-index session_create_idempotency_reconciliation_idx
create index concurrently session_create_idempotency_reconciliation_idx
  on session_create_idempotency (lease_expires_at, tenant_id, session_id)
  where state = 'in_progress';
