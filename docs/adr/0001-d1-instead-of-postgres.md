# 0001: D1 instead of Postgres

Status: accepted (spec v1, section 5)

## Context

Omni keeps its data in PlanetScale Postgres behind Hyperdrive. Wurmhol's data is small: users,
orgs, members, hashed tokens, subscriptions and share history. Its hot path (relaying a share's
traffic) lives in Durable Objects and reads the database only to check a token or a membership.

## Decision

Wurmhol stores everything in one Cloudflare D1 database, through Drizzle's SQLite dialect.
Better Auth runs on it through Drizzle's adapter (`provider: "sqlite"`). Migrations come from
`drizzle-kit generate` and are applied with `wrangler d1 migrations apply`, locally (Miniflare's
D1) and in production (`.github/workflows/production.yml`).

## Consequences

- One vendor fewer and a smaller bill: no database to provision, and self-hosting needs only a
  Cloudflare account.
- Local dev and the e2e suites need no Docker: `wrangler` runs D1 on local SQLite.
- SQLite types: timestamps are integers (`mode: "timestamp_ms"`), booleans are integers. No
  `ilike` and no row-level locks; uniqueness and single-use guarantees come from unique indexes,
  conditional `UPDATE … WHERE`, or a Durable Object.
- D1 has no interactive transactions from a Worker; multi-statement writes use `db.batch()`.
- Schema stays additive-first, as in Omni: migrations run before the new Worker version serves.
