# services/

Per-service invariants and surprising contracts.

**Not applicable to this project (verified 2026-08-09):** Octoshell has no backend service — no
HTTP server, no database, no daemon. The `.octobots/` markdown tree on disk is the only
persistence layer (see `../architecture/disk-is-authoritative.md`). Kept as a named home in case
that changes — e.g. if the planned `octograph` CLI (see
`docs/superpowers/specs/2026-08-09-octograph-design.md`) grows a long-running component, though
its own design explicitly commits to "no server, no daemon, no database" too.

## Index

_Empty — no notes yet._
