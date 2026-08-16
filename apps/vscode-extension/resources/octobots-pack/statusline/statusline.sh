#!/usr/bin/env bash
# octobots-pack-version: 55
# Claude Code status line — vivid accent palette
# Fields: model name | git branch (+dirty) | session token count | context remaining
# Reads JSON from stdin (Claude Code's statusLine protocol)

input=$(cat 2>/dev/null) || exit 0

# Parsed with node, not jq. node is already a hard requirement of this pack (every hook is a .mjs),
# so depending on jq as well bought a second system dependency for this one script — and when it was
# missing the line rendered empty, which reads as "the status line is broken". This also collapses
# what used to be SIX jq subprocesses per render into one node call; the status line re-renders
# constantly, so that cost was paid over and over.
fields=$(printf '%s' "$input" | node -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let j = {};
  try { j = JSON.parse(raw || "{}"); } catch { /* a malformed payload yields empty fields, not a crash */ }
  const cw = j.context_window || {};
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
  const out = {
    model: (j.model && j.model.display_name) || "Claude",
    cwd: (j.workspace && j.workspace.current_dir) || "",
    tokens: num(cw.total_input_tokens) + num(cw.total_output_tokens),
    remaining_pct: cw.remaining_percentage === undefined ? "" : cw.remaining_percentage,
    ctx_size: num(cw.context_window_size),
    total_input: num(cw.total_input_tokens),
  };
  // One key=value per line. Values are newline-free by construction, so a plain read loop is safe.
  for (const [k, v] of Object.entries(out)) process.stdout.write(k + "=" + String(v) + "\n");
});
' 2>/dev/null)

field() { printf '%s\n' "$fields" | sed -n "s/^$1=//p"; }

# ---------- ANSI 256-color helpers ----------
# Bold bright cyan  (model)
CY='\033[1;38;5;51m'
# Bold bright magenta (git)
MG='\033[1;38;5;213m'
# Bold bright yellow  (tokens)
YL='\033[1;38;5;220m'
# Context remaining colors (threshold-based)
GN='\033[1;38;5;82m'   # Bold bright green  (>50% remaining)
OR='\033[1;38;5;214m'  # Bold orange        (20-50% remaining)
RD='\033[1;38;5;196m'  # Bold bright red    (<20% remaining)
# Dim white separator
SEP='\033[2;37m'
# Reset
RS='\033[0m'

SEP_CHAR=" · "

# ---------- 1. Model name ----------
model_raw=$(field model)
[ -n "$model_raw" ] || model_raw="Claude"
# Strip leading "Claude " prefix to keep it compact (e.g. "Claude Opus 4" → "Opus 4")
model_short="${model_raw#Claude }"

# ---------- 2. Git branch + dirty indicator ----------
git_part=""
cwd_dir=$(field cwd)
[ -z "$cwd_dir" ] && cwd_dir="$(pwd)"

if git -C "$cwd_dir" rev-parse --git-dir --no-optional-locks &>/dev/null 2>&1; then
    branch=$(git -C "$cwd_dir" symbolic-ref --short HEAD 2>/dev/null \
             || git -C "$cwd_dir" rev-parse --short HEAD 2>/dev/null \
             || echo "?")
    # Count staged+unstaged changes (skip untracked for speed)
    dirty=$(git -C "$cwd_dir" status --porcelain --untracked-files=no 2>/dev/null | wc -l | tr -d ' ')
    if [ "$dirty" -gt 0 ] 2>/dev/null; then
        git_part="${branch} *"
    else
        git_part="${branch}"
    fi
fi

# ---------- 3. Session token count (human-readable absolute number) ----------
token_part=""
# Sum total_input_tokens + total_output_tokens from context_window
total_tokens=$(field tokens)

if [ -n "$total_tokens" ] && [ "$total_tokens" -gt 0 ] 2>/dev/null; then
    token_part=$(echo "$total_tokens" | awk '{
        if ($1 >= 1000000)      printf "%.1fM", $1/1000000
        else if ($1 >= 1000)    printf "%.1fk", $1/1000
        else                    printf "%d",    $1
    }')
fi

# ---------- 4. Context remaining ----------
ctx_part=""
ctx_color="$GN"

remaining_pct=$(field remaining_pct)
ctx_size=$(field ctx_size)
total_input=$(field total_input)

if [ -n "$remaining_pct" ] && [ -n "$ctx_size" ] && [ "$ctx_size" -gt 0 ] 2>/dev/null; then
    # Remaining token count
    remaining_tokens=$(echo "$ctx_size $total_input" | awk '{r = $1 - $2; if (r < 0) r = 0; print r}')
    remaining_human=$(echo "$remaining_tokens" | awk '{
        if ($1 >= 1000000)   printf "%.1fM", $1/1000000
        else if ($1 >= 1000) printf "%.0fk", $1/1000
        else                 printf "%d",    $1
    }')
    # Use printf "%s" to avoid interpreting % in the format string
    pct_int=$(printf "%s" "$remaining_pct" | awk '{printf "%.0f", $1}')
    ctx_part="${remaining_human} / ${pct_int}% left"

    # Pick color by threshold
    if [ "$pct_int" -gt 50 ] 2>/dev/null; then
        ctx_color="$GN"
    elif [ "$pct_int" -gt 20 ] 2>/dev/null; then
        ctx_color="$OR"
    else
        ctx_color="$RD"
    fi
fi

# ---------- Assemble the colored line into a variable ----------
# Use printf "%s" for all text arguments so literal % chars in values
# are never interpreted as format directives.
line=""
line="${line}$(printf "%b%s%b" "$CY" "$model_short" "$RS")"

if [ -n "$git_part" ]; then
    line="${line}$(printf "%b%s%b%b%s%b" "$SEP" "$SEP_CHAR" "$RS" "$MG" "$git_part" "$RS")"
fi

if [ -n "$token_part" ]; then
    line="${line}$(printf "%b%s%b%b%s%b" "$SEP" "$SEP_CHAR" "$RS" "$YL" "$token_part" "$RS")"
fi

if [ -n "$ctx_part" ]; then
    line="${line}$(printf "%b%s%b%b%s%b" "$SEP" "$SEP_CHAR" "$RS" "$ctx_color" "$ctx_part" "$RS")"
fi

# ---------- Right-align ----------
# Determine terminal width: prefer $COLUMNS (exported by Claude Code's env),
# fall back to tput on the real TTY, then hard-code 120.
term_width="${COLUMNS:-}"
if [ -z "$term_width" ] || [ "$term_width" -le 0 ] 2>/dev/null; then
    # Brace-group the redirect too: `tput ... </dev/tty 2>/dev/null` silences tput but NOT the
    # shell's own "/dev/tty: Device not configured" when no controlling terminal exists (any
    # non-interactive host). That noise lands on the status line's stderr for every render.
    term_width=$( { tput cols </dev/tty; } 2>/dev/null )
fi
if [ -z "$term_width" ] || [ "$term_width" -le 0 ] 2>/dev/null; then
    term_width=120
fi

# Measure visible width by stripping ANSI escape sequences from a copy.
visible=$(printf "%s" "$line" | sed 's/\x1b\[[0-9;]*m//g')
visible_len=${#visible}

# Compute left-padding; never go negative.
pad=$(( term_width - visible_len ))
[ "$pad" -lt 0 ] && pad=0

# Print padding then the colored line.
printf "%${pad}s%s\n" "" "$line"
