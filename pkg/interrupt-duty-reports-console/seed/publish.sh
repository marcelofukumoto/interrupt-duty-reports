#!/bin/sh
# Put one finished run into the cluster, where the extension reads it back.
#
# Two ConfigMaps per report, and the split is the whole reason this is a script. The summary is
# small and every one of them is fetched to draw the list; the payload is the report itself and
# is fetched only when somebody opens it. Keeping them in one object would mean the list page
# downloading a hundred reports in full to render a hundred rows of dates.
#
# The agent calls this rather than composing kubectl itself: the labels are what the extension
# selects on, so a report published with a typo'd label is a report that exists and cannot be
# found. It is also where the hundred-report cap is enforced, because publishing is the only
# moment the cap can be exceeded.
#
# usage: publish.sh <run-dir> <report-id> done
#        publish.sh <run-dir> <report-id> fail "one-line reason"
set -e

DIR=${1:?publish.sh needs the run directory}
ID=${2:?publish.sh needs the report id}
RESULT=${3:?publish.sh needs done or fail}
MESSAGE=${4:-}

NS=interrupt-duty-reports-console
LABEL=interrupt-duty.rancher.io
KEEP=${KEEP_REPORTS:-100}

# A ConfigMap holds at most 1 MiB. A report that does not fit has to fail as a report rather
# than as a kubectl error nobody will read, so it is checked before anything is applied.
MAX_REPORT_BYTES=900000

# Whose kubectl.
#
# shell.sh gives a pane the Rancher identity of whoever opened it (seed/rancher-credential.sh),
# which is the right credential to write with: attributable, and no more rights than that
# person has. But it is only there once somebody has opened the agents drawer at least once,
# and it can be expired - so the pod's own ServiceAccount, which is always mounted, is the
# fallback. KUBECONFIG naming nothing is what sends kubectl to the in-cluster config.
KUBE_FALLBACK=''

kube() {
  if [ -n "$KUBE_FALLBACK" ]; then
    KUBECONFIG=/dev/null kubectl "$@"
  else
    kubectl "$@"
  fi
}

if ! kubectl auth can-i create configmaps --namespace "$NS" >/dev/null 2>&1; then
  KUBE_FALLBACK=yes
fi

# Whatever happens from here, the tokens do not outlive the run.
cleanup_credentials() {
  rm -f "$DIR/creds.json"
}

# Re-applied on both paths, so a run that fails still leaves a row saying so rather than one
# stuck on "running" until somebody notices.
apply_summary() {
  kube create configmap "$ID" \
    --namespace "$NS" \
    --from-file=meta.json="$DIR/meta.json" \
    --dry-run=client -o json |
    node -e '
      const [id, label] = process.argv.slice(1);
      let raw = "";

      process.stdin.on("data", (c) => (raw += c));
      process.stdin.on("end", () => {
        const cm = JSON.parse(raw);

        cm.metadata.labels = {
          [`${ label }/report`]: "summary",
          [`${ label }/report-id`]: id,
        };
        process.stdout.write(JSON.stringify(cm));
      });
    ' "$ID" "$LABEL" |
    kube apply -f - >/dev/null
}

finish_failed() {
  cleanup_credentials
  node -e '
    const fs = require("fs");
    const [file, message] = process.argv.slice(1);
    const meta = JSON.parse(fs.readFileSync(file, "utf8"));

    meta.status = "failed";
    meta.error = String(message || "the run failed").replace(/\s+/g, " ").trim().slice(0, 500);
    meta.finishedAt = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(meta));
  ' "$DIR/meta.json" "$1"
  apply_summary
  echo "publish.sh: recorded a failure for $ID - $1"
  exit 0
}

# The cap, oldest first. Report ids are `daily-<date>-<time>`, so sorting the names sorts them
# by when they were made, and everything past the newest $KEEP goes - the payload with the
# summary, since a payload whose summary is gone can never be opened again.
prune() {
  kube get configmaps --namespace "$NS" \
    -l "$LABEL/report=summary" \
    -o "jsonpath={range .items[*]}{.metadata.name}{\"\n\"}{end}" 2>/dev/null |
    sort -r |
    tail -n "+$((KEEP + 1))" |
    while read -r old; do
      [ -n "$old" ] || continue
      echo "publish.sh: pruning $old (over the $KEEP-report cap)"
      kube delete configmap --namespace "$NS" --ignore-not-found "$old" "$old-report" >/dev/null 2>&1 || true
    done
}

[ -f "$DIR/meta.json" ] || { echo "publish.sh: $DIR/meta.json is missing - the run was not set up" >&2; exit 2; }

kube get namespace "$NS" >/dev/null 2>&1 || kube create namespace "$NS" >/dev/null

if [ "$RESULT" = fail ]; then
  finish_failed "$MESSAGE"
fi

[ "$RESULT" = done ] || { echo "publish.sh: the result must be done or fail, not '$RESULT'" >&2; exit 2; }

# The report has to be a report before any of it is published. An agent that wrote prose, or
# stopped halfway through the JSON, must land as a failure somebody can see - not as a row that
# opens onto an error.
VALIDATION=$(node -e '
  const fs = require("fs");
  const [reportFile, metaFile, maxBytes] = process.argv.slice(1);
  const fail = (m) => {
    process.stdout.write(`INVALID ${ m }`);
    process.exit(0);
  };

  let text;

  try {
    text = fs.readFileSync(reportFile, "utf8");
  } catch (e) {
    fail(`report.json was never written (${ e.code || e.message })`);
  }

  if (Buffer.byteLength(text) > Number(maxBytes)) {
    fail(`report.json is ${ Math.round(Buffer.byteLength(text) / 1024) } KiB, over what a ConfigMap can hold`);
  }

  let report;

  try {
    report = JSON.parse(text);
  } catch (e) {
    fail(`report.json is not valid JSON: ${ e.message }`);
  }

  if (!report || typeof report !== "object" || Array.isArray(report)) {
    fail("report.json is not a JSON object");
  }

  const groups = {
    "jira.new":              report.jira?.new,
    "jira.in_triage":        report.jira?.in_triage,
    "jira.waiting_reporter": report.jira?.waiting_reporter,
    "github.issues":         report.github?.issues,
    "github.questions":      report.github?.questions,
  };

  for (const [name, value] of Object.entries(groups)) {
    if (!Array.isArray(value)) {
      fail(`report.json is missing the ${ name } array`);
    }
  }

  if (!Array.isArray(report.top3)) {
    fail("report.json is missing the top3 array");
  }

  // Taken from the arrays rather than from what the agent wrote beside them: these are what the
  // list shows without opening anything, and a count that disagrees with the report it labels
  // is worse than no count.
  const counts = {
    jira_new:              groups["jira.new"].length,
    jira_in_triage:        groups["jira.in_triage"].length,
    jira_waiting_reporter: groups["jira.waiting_reporter"].length,
    github_new:            groups["github.issues"].length,
    github_questions:      groups["github.questions"].length,
  };
  const actNow = Object.values(groups).flat().filter((item) => item?.class === "ACT_NOW").length;
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));

  meta.status = "complete";
  meta.finishedAt = new Date().toISOString();
  meta.reportDate = report.report_date || meta.reportDate;
  meta.headline = String(report.reminder?.line || "").slice(0, 400);
  meta.counts = counts;
  meta.actNow = actNow;
  meta.top3 = (report.top3 || []).slice(0, 3).map((t) => ({
    ref:   String(t?.ref || "").slice(0, 40),
    title: String(t?.title || "").slice(0, 200),
    class: String(t?.class || "").slice(0, 20),
  }));
  delete meta.error;

  fs.writeFileSync(metaFile, JSON.stringify(meta));
  process.stdout.write("OK");
' "$DIR/report.json" "$DIR/meta.json" "$MAX_REPORT_BYTES" 2>&1) || VALIDATION="INVALID publish.sh could not read the report: $VALIDATION"

case "$VALIDATION" in
  OK) ;;
  INVALID*) finish_failed "${VALIDATION#INVALID }" ;;
  *) finish_failed "publish.sh could not validate the report: $VALIDATION" ;;
esac

# The payload first. A summary that says "complete" while the report it points at is not there
# yet is a row somebody can click on and get nothing.
kube create configmap "$ID-report" \
  --namespace "$NS" \
  --from-file=report.json="$DIR/report.json" \
  --dry-run=client -o json |
  node -e '
    const [id, label] = process.argv.slice(1);
    let raw = "";

    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      const cm = JSON.parse(raw);

      cm.metadata.labels = {
        [`${ label }/report`]: "payload",
        [`${ label }/report-id`]: id,
      };
      process.stdout.write(JSON.stringify(cm));
    });
  ' "$ID" "$LABEL" |
  kube apply -f - >/dev/null

apply_summary
cleanup_credentials
prune

echo "publish.sh: published $ID"
