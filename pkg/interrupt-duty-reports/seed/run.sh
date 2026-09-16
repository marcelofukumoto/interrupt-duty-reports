#!/bin/sh
# Gather one run's data. Called by the agent as its first step.
#
# A script rather than a line in the prompt, so the one part of the run that must be identical
# every day is identical every day: the agent's job starts at data.json and stops at
# report.json, and neither end of that is left to it to improvise.
#
# usage: run.sh <run-dir>
set -e

DIR=${1:?run.sh needs the run directory}
SEED=$(dirname "$0")

[ -d "$DIR" ] || { echo "run.sh: no such run directory: $DIR" >&2; exit 2; }
[ -f "$DIR/creds.json" ] || { echo "run.sh: $DIR/creds.json is missing - the run was not set up" >&2; exit 2; }

# CREDS_FILE rather than exported tokens: every pane in this pod runs as the same user and can
# read another process's environment, so the tokens stay in a 0600 file that gather.mjs opens
# once and publish.sh removes at the end.
CREDS_FILE="$DIR/creds.json" OUT="$DIR/data.json" node "$SEED/gather.mjs"

echo "run.sh: wrote $DIR/data.json"
