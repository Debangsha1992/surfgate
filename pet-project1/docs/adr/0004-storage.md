# ADR 0004 — PostgreSQL + Redis + S3-compatible object storage

Status: Proposed baseline.

## PostgreSQL

Durable metadata, sessions, routing decisions, audit, task/artifact metadata.

## Redis

Ephemeral quotas, rate limiting, locks, revocation/cache, optional task queue.

## Object storage

Screenshots, PDFs, debug artifacts.

## Constraint

Redis is never the sole durable source for audit/history.
