alter table api_keys
  add constraint api_keys_known_scopes_check
  check (scopes <@ array[
    'sessions:read',
    'sessions:write',
    'sessions:terminate',
    'api-keys:manage'
  ]::text[]);

alter table sessions
  add constraint sessions_protected_provider_reference_check
  check (
    provider_session_reference_encrypted is null
    or provider_session_reference_encrypted ~ '^psr\.v1\.'
  ),
  add constraint sessions_active_metadata_check
  check (
    status not in ('active', 'terminating', 'terminated', 'expired')
    or (
      selected_runtime is not null
      and selected_provider is not null
      and provider_session_reference_encrypted is not null
      and connected_at is not null
      and expires_at is not null
    )
  ),
  add constraint sessions_terminal_timestamp_check
  check (
    (status in ('terminated', 'expired', 'failed'))
    = (terminated_at is not null and termination_reason is not null)
  ),
  add constraint sessions_connection_expiry_check
  check (connected_at is null or expires_at > connected_at);
