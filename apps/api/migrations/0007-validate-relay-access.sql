alter table api_keys validate constraint api_keys_known_scopes_check_v2;

alter table api_keys drop constraint api_keys_known_scopes_check;

alter table api_keys
  rename constraint api_keys_known_scopes_check_v2 to api_keys_known_scopes_check;
