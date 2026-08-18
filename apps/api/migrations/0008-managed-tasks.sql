alter table api_keys
  add constraint api_keys_known_scopes_check_v3
  check (scopes <@ array[
    'sessions:read', 'sessions:write', 'sessions:terminate', 'sessions:connect',
    'tasks:read', 'tasks:write', 'artifacts:read', 'api-keys:manage'
  ]::text[]) not valid;
alter table api_keys validate constraint api_keys_known_scopes_check_v3;
alter table api_keys drop constraint api_keys_known_scopes_check;
alter table api_keys rename constraint api_keys_known_scopes_check_v3 to api_keys_known_scopes_check;
alter table api_keys drop constraint api_keys_scopes_check;
alter table api_keys add constraint api_keys_scopes_check check (cardinality(scopes) between 1 and 8);

create table managed_tasks (
  id text primary key check (id ~ '^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  tenant_id text not null references tenants(id) on delete cascade,
  session_id text not null,
  task_type text not null check (task_type in ('extract', 'screenshot', 'pdf')),
  status text not null check (status in ('queued', 'running', 'retry_pending', 'succeeded', 'failed', 'cancelled')),
  request_json jsonb not null,
  result_json jsonb,
  attempt_count smallint not null default 0 check (attempt_count >= 0),
  max_attempts smallint not null check (max_attempts between 1 and 10),
  failure_code text,
  created_at timestamptz not null,
  updated_at timestamptz not null check (updated_at >= created_at),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  next_attempt_at timestamptz,
  claim_token text,
  lease_expires_at timestamptz,
  version bigint not null default 0 check (version >= 0),
  unique (tenant_id, id),
  unique (tenant_id, session_id, id),
  foreign key (tenant_id, session_id) references sessions(tenant_id, id) on delete cascade,
  check (attempt_count <= max_attempts),
  check ((status = 'running') = (claim_token is not null and lease_expires_at is not null)),
  check ((status = 'succeeded') = (result_json is not null and completed_at is not null)),
  check ((status = 'failed') = (failure_code is not null and failed_at is not null)),
  check (status <> 'retry_pending' or next_attempt_at is not null)
);

create index managed_tasks_tenant_created_idx on managed_tasks (tenant_id, created_at);
create index managed_tasks_tenant_status_idx on managed_tasks (tenant_id, status);
create index managed_tasks_claim_idx on managed_tasks (status, next_attempt_at, lease_expires_at, created_at);
create unique index managed_tasks_one_running_per_session_idx
  on managed_tasks (tenant_id, session_id) where status = 'running';

create table task_create_idempotency (
  tenant_id text not null,
  session_id text not null,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  task_id text not null,
  created_at timestamptz not null,
  primary key (tenant_id, session_id, idempotency_key),
  foreign key (tenant_id, session_id, task_id)
    references managed_tasks(tenant_id, session_id, id) on delete cascade
);

create table artifacts (
  id text primary key check (id ~ '^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  tenant_id text not null,
  task_id text not null,
  session_id text not null,
  media_type text not null check (media_type in ('image/png', 'image/jpeg', 'application/pdf')),
  byte_size bigint not null check (byte_size between 0 and 67108864),
  storage_key text not null unique check (storage_key ~ '^v1/ten_[0-7][0-9A-HJKMNP-TV-Z]{25}/tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}/art_[0-7][0-9A-HJKMNP-TV-Z]{25}/a[1-9][0-9]?-[0-9a-f]{16}$'),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > created_at),
  unique (tenant_id, id),
  unique (tenant_id, task_id),
  foreign key (tenant_id, session_id, task_id)
    references managed_tasks(tenant_id, session_id, id) on delete cascade
);

create index artifacts_tenant_created_idx on artifacts (tenant_id, created_at);
create index artifacts_expiry_idx on artifacts (expires_at);

alter table audit_events add column task_id text
  check (task_id is null or task_id ~ '^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$');
alter table audit_events add column artifact_id text
  check (artifact_id is null or artifact_id ~ '^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$');
