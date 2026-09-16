#!/bin/sh
# Gather one run's data. Called by the agent as its first step.
#
# A script rather than a line in the prompt, so the one part of the run that must be identical
# every day is identical every day: the agent's job starts at data.json and stops at
# report.json, and neither end of that is left to it to improvise.
#
# It also resolves the two credentials, and does that here rather than in the browser. A token
# pasted into a page used to be written into this pod over the exec socket for every run; now it
# is stored once in a Secret and read at the moment it is needed, by the pod, with the pod's own
# ServiceAccount. The browser never holds one, so there is nothing for it to leak.
#
# usage: run.sh <run-dir>
set -e

DIR=${1:?run.sh needs the run directory}
SEED=$(dirname "$0")

[ -d "$DIR" ] || { echo "run.sh: no such run directory: $DIR" >&2; exit 2; }

NS=interrupt-duty-reports-console
SECRET=settings
# Extension Studio keeps an account's GitHub token under this exact name. Ours is preferred -
# setting one here is somebody choosing it for this extension - and theirs is the fallback, so
# nobody has to keep two copies of one secret in step.
STUDIO_NS=extension-studio
STUDIO_SECRET=settings

# kubectl as the pod rather than as whoever opened a terminal in it. shell.sh writes a kubeconfig
# carrying the Rancher identity of the person who opened the pane (seed/rancher-credential.sh),
# and that identity may not be allowed to read these Secrets - the pod's ServiceAccount is. A
# KUBECONFIG naming nothing is what sends kubectl to the in-cluster config.
secret_key() {
  KUBECONFIG=/dev/null kubectl get secret "$2" -n "$1" -o "jsonpath={.data.$3}" 2>/dev/null \
    | base64 -d 2>/dev/null \
    | tr -d '\r\n'
}

GH_TOKEN=$(secret_key "$NS" "$SECRET" gh_token)
[ -n "$GH_TOKEN" ] || GH_TOKEN=$(secret_key "$STUDIO_NS" "$STUDIO_SECRET" gh_token)
JIRA_PAT=$(secret_key "$NS" "$SECRET" jira_pat)

missing=''
[ -n "$JIRA_PAT" ] || missing="a Jira token"
[ -n "$GH_TOKEN" ] || missing="${missing:+$missing and }a GitHub token"

if [ -n "$missing" ]; then
  echo "run.sh: $missing is not stored. Set it from the extension's Credentials dialog." >&2
  exit 2
fi

# 0600 before anything is in it, so it is never briefly readable, and owned by the pane's user
# because that is who runs the gather. Removed by publish.sh however the run ends.
CREDS="$DIR/creds.json"

: > "$CREDS"
chmod 600 "$CREDS"

# Through node rather than printf, so a token containing a quote or a backslash is JSON-encoded
# rather than pasted into a string and hoped for.
GH_TOKEN="$GH_TOKEN" JIRA_PAT="$JIRA_PAT" node -e \
  'require("fs").writeFileSync(process.argv[1], JSON.stringify({ JIRA_PAT: process.env.JIRA_PAT, GH_TOKEN: process.env.GH_TOKEN }))' \
  "$CREDS"

CREDS_FILE="$CREDS" OUT="$DIR/data.json" node "$SEED/gather.mjs"

echo "run.sh: wrote $DIR/data.json"
