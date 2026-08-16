#!/usr/bin/env bash
# octobots-pack-version: 55
# Claude Code status line — vivid accent palette
# Fields: model name | git branch (+dirty) | session token count | context remaining
# Reads JSON from stdin (Claude Code's statusLine protocol)

input=$(cat 2>/dev/null) || exit 0

# Every field below is parsed with jq. Without it the original produced an empty line, which looks
# like a broken status line rather than a missing tool — so say so once, plainly, and stop.
if ! command -v jq >/dev/null 2>&1; then
  printf '\033[2;37m(octobots status line needs `jq` — install it, or clear statusLine in .claude/settings.json)\033[0m\n'
  exit 0
fi

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
model_raw=$(echo "$input" | jq -r '.model.display_name // "Claude"')
# Strip leading "Claude " prefix to keep it compact (e.g. "Claude Opus 4" → "Opus 4")
model_short="${model_raw#Claude }"

# ---------- 2. Git branch + dirty indicator ----------
git_part=""
cwd_dir=$(echo "$input" | jq -r '.workspace.current_dir // empty')
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
total_tokens=$(echo "$input" | jq -r '
  (.context_window.total_input_tokens  // 0) +
  (.context_window.total_output_tokens // 0)
')

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

remaining_pct=$(echo "$input" | jq -r '.context_window.remaining_percentage // empty')
ctx_size=$(echo "$input" | jq -r '.context_window.context_window_size // empty')
total_input=$(echo "$input" | jq -r '.context_window.total_input_tokens // empty')

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
