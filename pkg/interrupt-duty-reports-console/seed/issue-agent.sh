#!/bin/sh
# One long-lived agent per issue, resumed across reports.
#
# A report used to be one agent doing everything, so what it learned about a ticket died with
# the run and the next day's report started from nothing. An issue outlives a report: the same
# SURE-1234 comes back tomorrow with one more comment on it, and the useful question is "what
# changed since you last looked", which only something that looked before can answer.
#
# So each issue gets a claude conversation of its own that is RESUMED rather than restarted.
# What it knew yesterday it still knows today, in its own words, without a summary having to
# carry it.
#
#   issue-agent.sh ask   <key> <prompt-file>   # find or create, resume, print the answer
#   issue-agent.sh id    <key>                 # the claude session uuid, or nothing
#   issue-agent.sh end   <key>                 # the ticket is closed; forget it
#   issue-agent.sh list                        # every issue with an agent
#
# A DIRECTORY PER ISSUE, which is the whole trick. claude keeps one transcript per working
# directory under ~/.claude/projects/<dir with slashes as dashes>, so an issue's directory holds
# exactly one conversation and "which transcript is this agent's" has a single answer. The
# agent panel's own panes share one directory and have to guess by watching which file appears -
# see the comment in claude-session.sh about two panes starting at the same moment. Here there
# is nothing to guess.
set -e

ROOT=${ISSUE_AGENT_ROOT:-/workspace/idr-issues}
CLAUDE=${CLAUDE_BIN:-/workspace/.home/.local/bin/claude}

# claude refuses --dangerously-skip-permissions as root, and the pod's exec lands as root.
[ "$(id -u)" = "0" ] && exec setpriv --reuid=1000 --regid=1000 --init-groups \
  /usr/bin/env HOME=/workspace/.home ISSUE_AGENT_ROOT="$ROOT" CLAUDE_BIN="$CLAUDE" \
  /bin/sh "$0" "$@"

export HOME=${HOME:-/workspace/.home}

# An issue key as a directory name. Keys are `PROJ-123`, but a key from a feed is not to be
# trusted with a path: anything that is not a letter, digit or hyphen becomes a hyphen.
slug() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]\{1,\}/-/g; s/^-*//; s/-*$//' | cut -c1-60
}

dir_for() { echo "$ROOT/$(slug "$1")"; }

# The transcript in a directory, which is this issue's conversation. Exactly one, by construction.
transcript_in() {
  ls "$HOME/.claude/projects/$(printf '%s' "$1" | tr '/' '-')"/*.jsonl 2>/dev/null | head -1
}

cmd=${1:?issue-agent.sh needs a command}

case "$cmd" in
  id)
    d=$(dir_for "${2:?needs an issue key}")
    [ -s "$d/session.id" ] && cat "$d/session.id" || true
    ;;

  list)
    for d in "$ROOT"/*/; do
      [ -d "$d" ] || continue
      k=$(cat "$d/key" 2>/dev/null || basename "$d")
      printf '%s\t%s\t%s\n' "$k" "$(basename "$d")" "$(cat "$d/session.id" 2>/dev/null || echo -)"
    done
    ;;

  end)
    # The ticket is closed, so the agent is too: the directory and the transcript both go. Kept
    # until then rather than pruned by age - an issue quiet for a month is still the same issue.
    d=$(dir_for "${2:?needs an issue key}")
    t=$(transcript_in "$d" || true)
    [ -n "$t" ] && rm -f "$t"
    rm -rf "$d"
    echo "issue-agent: ended ${2}"
    ;;

  ask)
    KEY=${2:?needs an issue key}
    FILE=${3:?needs a prompt file}
    [ -f "$FILE" ] || { echo "issue-agent: no such prompt file: $FILE" >&2; exit 2; }

    d=$(dir_for "$KEY")
    mkdir -p "$d"
    printf '%s' "$KEY" > "$d/key"
    cd "$d"

    if [ -s "$d/session.id" ]; then
      # Resume by name. The fallback is not "start fresh silently": a transcript that has gone
      # means the memory has gone, and the caller should see a first-contact answer rather than
      # believe it got a remembered one.
      "$CLAUDE" --dangerously-skip-permissions --resume "$(cat "$d/session.id")" -p "$(cat "$FILE")" ||
        { echo "issue-agent: could not resume $KEY, starting fresh" >&2; rm -f "$d/session.id"; "$CLAUDE" --dangerously-skip-permissions -p "$(cat "$FILE")"; }
    else
      "$CLAUDE" --dangerously-skip-permissions -p "$(cat "$FILE")"
    fi

    # Record the session AFTER the first run, when the transcript exists. One per directory, so
    # there is nothing to disambiguate.
    if [ ! -s "$d/session.id" ]; then
      t=$(transcript_in "$d" || true)
      [ -n "$t" ] && basename "$t" .jsonl > "$d/session.id"
    fi
    ;;

  *)
    echo "issue-agent.sh: unknown command: $cmd" >&2
    exit 2
    ;;
esac
