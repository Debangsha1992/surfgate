alter table managed_tasks
  add column trace_parent text
  check (trace_parent is null or trace_parent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$');
