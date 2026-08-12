---
name: agent-generated system load must be torn down by a trap, not by recorded PIDs
description: >-
  An agent testing CPU contention spawned 20 `while true` busy loops, recorded
  their PIDs for cleanup, and leaked all 20 — the outer shell exited, the
  subshells were reparented to PID 1, and the recorded PIDs no longer matched
  anything the cleanup could kill. 13.7 cores burned for 70 minutes on the
  user's machine.
type: reference
verified: 2026-08-11
method: >-
  Observed live. `ps -eo pid,ppid,pcpu,etime,command` showed 20 processes with
  PPID 1, state RN, ~36% instantaneous CPU each and 45 minutes of accumulated
  CPU time apiece, all with identical elapsed time (01:09:42) and the command
  line `for i in $(seq 1 20); do ( while true; do :; done ) & done` inherited
  from the forked parent. Summing `pcpu` across the set gave 1367% — 13.7
  cores. Killing on the `while true; do :; done` signature cleared all 20 and
  returned the machine to idle.
tags: [area/agents, area/testing, kind/resource-leak]
aliases: [busy loop leak, orphaned load generators, CPU contention test cleanup]
---

## The trap

An agent asked to determine whether CPU contention could reproduce an
intermittent CI failure did the reasonable thing: it generated load.

```sh
for i in $(seq 1 20); do ( while true; do :; done ) & done
BUSY_PIDS=$(jobs -p)
echo "$BUSY_PIDS" > /tmp/.../busy.pids     # for cleanup
```

The experiment itself was sound and its result was a genuine negative — the
suite stayed green under load, ruling out contention as the cause. The cleanup
is what failed, and it failed in a way that looks correct in the transcript:

`jobs -p` records the PIDs of the **subshells**. When the outer `zsh -c` exited,
those subshells were reparented to PID 1 and kept running. Anything that later
tried to kill "the recorded PIDs" from a *new* shell had no job table, and the
processes were no longer children of anything the cleanup could reach. The agent
reported the experiment as complete and clean. The load ran for another 70
minutes.

Two things made this invisible:

- **The agent's own report was accurate about the experiment and silent about the
  machine.** "Ran the full suite under 20 core-pegging busy-loops, 2 runs, both
  passed" is true. It says nothing about whether the loops stopped.
- **The symptom looked like someone else's problem.** The user saw many Python
  processes at high CPU and asked about those; the Python was an unrelated
  project's dev server, and the real 13.7-core consumer was 20 `zsh` processes
  whose command line was truncated in `ps` output before the `while true` was
  visible.

## The rule

> **Any agent-generated system load must be torn down by a `trap` on the shell
> that created it, and its absence verified with `ps` before the agent reports.**
> Recorded PIDs are not a teardown mechanism — they survive only as long as the
> process tree does.

```sh
# create the load in its own process group, and kill the group on ANY exit path
set -m
trap 'kill -- -$$ 2>/dev/null' EXIT INT TERM
for i in $(seq 1 20); do ( while true; do :; done ) & done
# ... run the experiment ...
# and before reporting:
pgrep -f 'while true; do :; done' | wc -l    # must be 0
```

When dispatching an agent that may generate load, put the teardown requirement
**in the prompt**, and require the report to state what was spawned and the
evidence it is gone. An instruction to "try heavy parallelism" with no teardown
contract is an instruction to leak.

## Why this is the same defect as the fixture leak

This repo already lost 2,502 git fixture repos and 1.2 GB to
[[graph-fixture-map-output-must-be-gitignored-before-a-second-run]]'s sibling
problem — resources created by a test-adjacent action with no owner responsible
for removing them, which only ever hurt on someone else's machine. That one was
fixed by `mkdtempClean()` registering teardown via `onTestFinished`, so the
cleanup is structural rather than remembered.

Load generators need the same treatment: **the thing that creates the resource
registers its own destruction, at creation time.** A cleanup step written after
the resource exists is a cleanup step that can be skipped, forgotten, or — as
here — silently aimed at the wrong handles.
