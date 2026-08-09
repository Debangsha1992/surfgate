create or replace function prevent_audit_event_mutation() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'audit events are immutable';
end;
$$;
