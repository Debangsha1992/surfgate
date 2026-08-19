-- surfgate:online-index sessions_reconciliation_terminating_idx
create index concurrently sessions_reconciliation_terminating_idx
  on sessions (updated_at, tenant_id, id)
  where status = 'terminating';
