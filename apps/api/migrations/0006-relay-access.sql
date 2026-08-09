alter table api_keys drop constraint api_keys_known_scopes_check;

alter table api_keys
  add constraint api_keys_known_scopes_check
  check (scopes <@ array[
    'sessions:read',
    'sessions:write',
    'sessions:terminate',
    'sessions:connect',
    'api-keys:manage'
  ]::text[]);
