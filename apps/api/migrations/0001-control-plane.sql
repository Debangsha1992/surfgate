create table tenants (
  id text primary key check (id ~ '^ten_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  name text not null check (char_length(name) between 1 and 200),
  status text not null check (status in ('active', 'suspended', 'disabled')),
  plan text not null check (plan ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  created_at timestamptz not null,
  updated_at timestamptz not null check (updated_at >= created_at)
);

create table api_keys (
  id text primary key check (id ~ '^key_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  tenant_id text not null references tenants(id) on delete cascade,
  key_prefix text not null unique check (key_prefix ~ '^sg_(live|test)_[0-9a-f]{12}$'),
  key_hash text not null check (key_hash ~ '^scrypt-v1\$'),
  scopes text[] not null check (cardinality(scopes) between 1 and 4),
  created_at timestamptz not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  check (expires_at is null or expires_at > created_at),
  check (revoked_at is null or revoked_at >= created_at)
);

create index api_keys_tenant_id_idx on api_keys (tenant_id);
create index api_keys_expiry_active_idx on api_keys (expires_at) where revoked_at is null;

create table sessions (
  id text primary key check (id ~ '^ses_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  tenant_id text not null references tenants(id) on delete cascade,
  status text not null check (status in (
    'pending', 'routing', 'allocating', 'fallback_allocating', 'active',
    'terminating', 'terminated', 'expired', 'failed'
  )),
  requested_capabilities jsonb not null,
  selected_runtime text,
  selected_provider text,
  provider_session_reference_encrypted text,
  routing_decision_id text,
  created_at timestamptz not null,
  updated_at timestamptz not null check (updated_at >= created_at),
  connected_at timestamptz,
  expires_at timestamptz,
  terminated_at timestamptz,
  termination_reason text,
  version bigint not null default 0 check (version >= 0),
  unique (tenant_id, id),
  check ((selected_runtime is null) = (selected_provider is null)),
  check (connected_at is null or connected_at >= created_at),
  check (expires_at is null or expires_at > created_at),
  check (terminated_at is null or terminated_at >= created_at)
);

create index sessions_tenant_id_idx on sessions (tenant_id);
create index sessions_tenant_id_id_idx on sessions (tenant_id, id);
create index sessions_status_idx on sessions (status);
create index sessions_expires_at_idx on sessions (expires_at) where expires_at is not null;

create table routing_decisions (
  id text primary key check (id ~ '^rtd_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  tenant_id text not null references tenants(id) on delete cascade,
  session_id text not null,
  request_id text not null check (request_id ~ '^req_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  policy_version text not null,
  capability_registry_version text not null,
  selected_provider text,
  selected_runtime text,
  decision_json jsonb not null,
  created_at timestamptz not null,
  unique (tenant_id, id),
  constraint routing_decisions_session_fk
    foreign key (tenant_id, session_id) references sessions(tenant_id, id) on delete cascade,
  check ((selected_provider is null) = (selected_runtime is null))
);

create index routing_decisions_tenant_session_idx on routing_decisions (tenant_id, session_id);
create index routing_decisions_created_at_idx on routing_decisions (created_at);

alter table sessions
  add constraint sessions_routing_decision_fk
  foreign key (tenant_id, routing_decision_id)
  references routing_decisions(tenant_id, id)
  deferrable initially deferred;
