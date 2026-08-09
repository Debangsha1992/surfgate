alter table api_keys
  add constraint api_keys_known_scopes_check_v2
  check (scopes <@ array[
    'sessions:read',
    'sessions:write',
    'sessions:terminate',
    'sessions:connect',
    'api-keys:manage'
  ]::text[]) not valid;
