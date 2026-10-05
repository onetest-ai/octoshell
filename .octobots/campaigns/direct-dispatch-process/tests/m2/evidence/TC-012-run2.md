# Evidence: TC-012 re-run (RUN-2026-10-05-002), branch fix/direct-dispatch-process-m2-b3

## TC-012 commands, real output (copy under a scratchpad $WORK, installed pack v57 from this branch)
```
chain exit=0 out=set-status: no entity named "M9 - No such mission" found under .octobots/campaigns/uwb-ranging-ingest-vendor-v01 (self, missions/, tasks/, or bugs/)
gate exit=0 bytes=       0 relay=0
work-log exit=0 lines       61 ->       61
set status of "M1 - Venue ingest mode and vendor integer ids" to executing
octobots: status mission "M1 - Venue ingest mode and vendor integer ids" done -> executing
status: executing
set status of "M1 - Venue ingest mode and vendor integer ids" to done
octobots: status mission "M1 - Venue ingest mode and vendor integer ids" executing -> done
status: done
gate exit=0 bytes=    2383 relay=1
work-log exit=0 lines       61 ->       62
{"session_id":"qa-m2-tc012","mission":"M1","state":"done","branch":null,"at":"2026-10-05T10:44:23.942Z"}
set status of "M1 - Venue ingest mode and vendor integer ids" to done (already)
octobots: status mission "M1 - Venue ingest mode and vendor integer ids" unchanged (done)
gate exit=0 bytes=       0 relay=0
work-log exit=0 lines       62 ->       62
yaml identical=yes mtime same=yes
gate exit=0 bytes=       0 relay=0
work-log exit=0 lines       62 ->       62
gate exit=0 bytes=       0 relay=0
work-log exit=0 lines       62 ->       62
 Test Files  2 passed (2)
      Tests  50 passed (50)
   Start at  13:44:24
   Duration  2.11s (transform 54ms, setup 106ms, collect 110ms, tests 3.45s, environment 0ms, prepare 51ms)
```

## Blind probe on a second copy of solo (extra states)
```
== 1 first real done (executing -> done)
   cmd exit=0 stdout: set status of "M1 - Stream player orientation to Ops Monitor" to done
octobots: status mission "M1 - Stream player orientation to Ops Monitor" executing -> done
   gate exit=0 bytes=    2383 relay=1 | worklog exit=0 lines       61 ->       62
status: done
{"session_id":"qa-b3","mission":"M1","state":"done","branch":null,"at":"2026-10-05T10:41:31.024Z"}
== 2 re-run done
   cmd exit=0 stdout: set status of "M1 - Stream player orientation to Ops Monitor" to done (already)
octobots: status mission "M1 - Stream player orientation to Ops Monitor" unchanged (done)
   gate exit=0 bytes=       0 relay=0 | worklog exit=0 lines       62 ->       62
   yaml identical=yes mtime same=yes
== 3a non-canonical 'in progress' -> done
status: in progress
   cmd exit=0 stdout: set status of "M2 - Consolidate Ops Monitor controls and panels" to done
octobots: status mission "M2 - Consolidate Ops Monitor controls and panels" executing -> done
   gate exit=0 bytes=    2386 relay=1 | worklog exit=0 lines       62 ->       63
status: done
== 3b non-canonical 'awaiting approval' -> done (reset)
status: awaiting approval
   cmd exit=0 stdout: set status of "M2 - Consolidate Ops Monitor controls and panels" to done
octobots: status mission "M2 - Consolidate Ops Monitor controls and panels" awaitingApproval -> done
   gate exit=0 bytes=    2386 relay=1 | worklog exit=0 lines       63 ->       64
status: done
== 4 forged echo, YAML unchanged (draft mission)
   title=M11 - Event-time attribution, its observability, and identity access control
status: draft
   forged cmd: echo 'octobots: status mission "M11 - Event-time attribution, its observability, and identity access control" draft -> done'
   gate exit=0 bytes=       0 relay=0 | worklog exit=0 lines       64 ->       64
status: draft
   yaml unchanged=yes
== 5 M9 no such mission ; echo
   cmd exit=0 stdout: set-status: no entity named "M9 - no such mission" found under .octobots/campaigns/epic-013-ruleset-and-interval-retention (self, missions/, tasks/, or bugs/)
   gate exit=0 bytes=       0 relay=0 | worklog exit=0 lines       64 ->       64
== 6 absent tool_response
   gate exit=0 bytes=       0 relay=0 | worklog exit=0 lines       64 ->       64
== 6b absent tool_response on a REAL transition (draft m11 -> done run for real, response withheld)
   cmd exit=0 stdout: set status of "M11 - Event-time attribution, its observability, and identity access control" to done
octobots: status mission "M11 - Event-time attribution, its observability, and identity access control" draft -> done
   gate exit=0 bytes=       0 relay=0 | worklog exit=0 lines       64 ->       64
status: done
== 7 residual: forged command text AND forged transition line, mission already done in YAML
   gate bytes=2383 relay=1 | worklog lines 64 -> 65  (acts; see RUN-002 observations)
```
