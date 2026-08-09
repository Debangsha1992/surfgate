create table session_create_idempotency (
  tenant_id text not null references tenants(id) on delete cascade,
  method text not null check (method = 'POST'),
  endpoint text not null check (endpoint = '/v1/sessions'),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  owner_token text not null check (owner_token ~ '^[A-Za-z0-9_-]{32,128}$'),
  state text not null check (state in ('in_progress', 'succeeded', 'failed')),
  session_id text,
  http_status integer,
  error_code text,
  lease_expires_at timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, method, endpoint, idempotency_key),
  foreign key (tenant_id, session_id) references sessions(tenant_id, id) on delete cascade,
  check ((state = 'in_progress') = (http_status is null)),
  check (updated_at >= created_at)
);

create index session_create_idempotency_session_idx
  on session_create_idempotency (tenant_id, session_id);
create index session_create_idempotency_lease_idx
  on session_create_idempotency (lease_expires_at) where state = 'in_progress';

create table session_allocation_attempts (
  tenant_id text not null,
  session_id text not null,
  attempt_number smallint not null check (attempt_number in (0, 1)),
  candidate_json jsonb not null,
  status text not null check (status in ('started', 'succeeded', 'failed')),
  failure_class text,
  fallback_eligible boolean,
  reason_codes text[] not null default '{}',
  started_at timestamptz not null,
  completed_at timestamptz,
  primary key (tenant_id, session_id, attempt_number),
  foreign key (tenant_id, session_id) references sessions(tenant_id, id) on delete cascade,
  check ((status = 'started') = (completed_at is null)),
  check (attempt_number = 0 or status <> 'started' or attempt_number = 1),
  check (completed_at is null or completed_at >= started_at)
);

create table audit_events (
  sequence_id bigserial primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  event_type text not null check (event_type ~ '^[a-z][a-z0-9.]{0,127}$'),
  request_id text not null check (request_id ~ '^req_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  session_id text,
  api_key_id text check (api_key_id is null or api_key_id ~ '^key_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  metadata jsonb not null default '{}',
  created_at timestamptz not null,
  foreign key (tenant_id, session_id) references sessions(tenant_id, id) on delete cascade
);

create index audit_events_tenant_created_idx on audit_events (tenant_id, created_at);
create index audit_events_tenant_session_idx on audit_events (tenant_id, session_id);

create function prevent_audit_event_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'audit events are immutable';
end;
$$;

create trigger audit_events_immutable_update before update on audit_events
  for each row execute function prevent_audit_event_mutation();
create trigger audit_events_immutable_delete before delete on audit_events
  for each row execute function prevent_audit_event_mutation();
