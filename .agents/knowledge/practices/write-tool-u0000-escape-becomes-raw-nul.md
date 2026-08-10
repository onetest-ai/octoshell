---
name: Typing a literal JS NUL-escape inside a Write/Edit content parameter writes a real NUL byte, not the six-character escape
description: The tool-call content parameter is JSON, so a literal JS/TS "backslash-u-0000" escape typed into it decodes to an actual 0x00 byte in the file on disk — this happens purely from typing the escape text into the parameter, with no existing broken file involved.
type: reference
applies_to: [js-dev, tech-lead, qa-engineer, scout]
verified: 2026-08-10
aliases: [self-inflicted NUL byte, Write tool NUL, JSON escape decodes to NUL, u0000 in Write content, backslash-u-0000 in Write content]
tags: [area/tooling]
---

## The fact

`Write`/`Edit`'s `content`/`new_string` parameters are transmitted as JSON. JSON defines the
six-character sequence **backslash, u, 0, 0, 0, 0** as the escape for the NUL character (U+0000).
If text typed into one of these parameters contains that sequence — even when the intent is "the
JS/TS source escape for a NUL byte separator", copied verbatim from a design doc's code sample —
the JSON layer decodes it before the file is written, and the byte that lands on disk is a **real,
raw 0x00 byte**, not six literal on-screen characters.

The resulting `.ts`/`.js` file then has the exact same problem [[grep-goes-binary-on-nul-bytes]]
describes — `grep` (without `-a`) reports no matches, `file` reports `data` instead of a text
type — except the cause is different: nothing was copied from an already-broken document; the
tool call itself manufactured the NUL byte from ordinary-looking escape text.

This is distinct from the scenario in `grep-goes-binary-on-nul-bytes.md`, where a raw control byte
was pasted into a markdown fixture and then propagated by literal copy. Here, the source text was
always clean ASCII; the NUL is introduced at write time by JSON-decoding of the tool-call
parameter, regardless of where the escape text came from. (This note itself had to be rewritten
once during authoring for exactly this reason — see "How this was verified" below — which is why
it is careful to describe the escape by name instead of typing it.)

## Why it matters / what it costs to get wrong

- A design doc or plan that uses that JS NUL escape as a set-key separator (a legitimate, if
  unusual, JS pattern) cannot be typed into a `Write`/`Edit` call verbatim — doing so silently
  corrupts the file being authored, and the corruption is invisible in the tool's own success
  response.
- The downstream cost is exactly `grep-goes-binary-on-nul-bytes.md`'s: a teammate's `grep` on the
  new file returns nothing and reads as "the code isn't there", CI diffing/linting tools may
  behave inconsistently on a `data`-typed source file, and the mis-classification isn't caught by
  `tsc`/`eslint` unless something downstream specifically scans for control bytes (this repo's
  `conventions.test.ts` does not).
- **Prefer a plain, unambiguous ASCII separator** (e.g. an arrow `->`, a pipe, a space) over any
  NUL-style separator in code authored through these tools. If a true NUL separator is ever
  genuinely required, produce it via a roundabout construction the JSON layer cannot pre-decode
  (e.g. `String.fromCharCode(0)` in the source — never type the raw six-character JS escape into
  a tool-call parameter) and verify the resulting file's byte count/`file` type afterward
  regardless.
- **This note is itself a live trap for whoever edits it**: describing the escape by typing it
  reproduces the bug in the note file. Always describe it by name ("the JS NUL escape", "U+0000")
  rather than typing the six-character sequence, in this note or anywhere else.

## How this was verified

2026-08-10, authoring `packages/graph/src/drift.ts` (T3.1, noise floor and drift): typed a
declared-pair-key separator matching a design.md snippet (that JS NUL escape, interpolated between
two template placeholders) into a `Write` call. Confirmed after writing:

```bash
file packages/graph/src/drift.ts        # -> "data" (not a recognised text type)
python3 -c "print(open('...','rb').read().count(b'\x00'))"   # -> 3
```

Three raw 0x00 bytes, at exactly the three call sites using the separator. Rewrote the file using
a plain `"->"` string constant instead and re-ran the same check: `file` reported a text type, NUL
count 0. `pnpm --filter @octoshell/graph lint`/`test`/`typecheck` all green afterward.

Reproduced a second time, immediately, while first drafting *this very note*: an earlier draft
quoted the escape literally in prose (inside backticks) to illustrate it, and the same `file`/NUL-
count check on the note file itself showed 9 raw NUL bytes. Rewritten to describe the escape by
name instead of typing it; re-checked at 0 NUL bytes before this note was considered done.

Related: [[grep-goes-binary-on-nul-bytes]] — same downstream symptom and detection method
(`grep -a`, `file`), different root cause (tool-call JSON decoding vs. a pasted raw byte
propagating between documents).
