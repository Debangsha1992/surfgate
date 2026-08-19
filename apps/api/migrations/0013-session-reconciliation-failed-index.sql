-- surfgate:online-index sessions_reconciliation_failed_idx
create index concurrently sessions_reconciliation_failed_idx
  on sessions (updated_at, tenant_id, id)
  where status = 'failed';
