alter table routing_decisions
  add constraint routing_decisions_tenant_session_decision_key
  unique (tenant_id, session_id, id);

alter table sessions
  drop constraint sessions_routing_decision_fk,
  add constraint sessions_routing_decision_fk
    foreign key (tenant_id, id, routing_decision_id)
    references routing_decisions(tenant_id, session_id, id)
    deferrable initially deferred;
