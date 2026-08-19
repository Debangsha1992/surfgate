-- surfgate:online-index sessions_reconciliation_inflight_idx
create index concurrently sessions_reconciliation_inflight_idx
  on sessions (updated_at, tenant_id, id)
  where status in ('pending', 'routing', 'allocating', 'fallback_allocating');
