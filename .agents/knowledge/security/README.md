# security/

Credential, auth, and egress invariants.

**Not applicable to this project (verified 2026-08-09):** no secrets, no auth surface, no network
egress in this repo — it's a local markdown board editor with no server. The one place secrets
could theoretically leak (a webview loading remote content) is explicitly guarded by VS Code's
webview CSP model; no project-specific finding here yet. Kept as a named home in case that
changes — e.g. if `octograph`'s optional Graphify integration or any future MCP server introduces
credentials or network calls.

## Index

_Empty — no notes yet._
