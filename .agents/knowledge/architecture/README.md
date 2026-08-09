# architecture/

System shape, the board model's on-disk format, and where mirrored/duplicated implementations
live and why. Cross-package or cross-process seams belong here.

**Not here:** feature-level implementation notes scoped to one file with no cross-cutting
implication — those either belong in a code comment or, if genuinely role-specific, in
`.agents/memory/<role>/`.

## Index

- [`disk-is-authoritative.md`](disk-is-authoritative.md) — reads rebuild the board model from disk;
  nothing cascade-mutates in memory.
- [`dual-schema-entity-io.md`](dual-schema-entity-io.md) — the board YAML schema is implemented
  twice with no import edge; both copies must change together.
