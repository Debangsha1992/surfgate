-- surfgate:online-index sessions_reconciliation_active_expiry_idx
create index concurrently sessions_reconciliation_active_expiry_idx
  on sessions (expires_at, updated_at, tenant_id, id)
  where status = 'active';
