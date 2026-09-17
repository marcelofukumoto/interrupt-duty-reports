#!/bin/sh
# Ask every item's own agent about its own item, one at a time.
#
# The report used to be one agent reading everything and writing everything, so what it learned
# about a ticket died with the run. Each item has a standing agent now (issue-agent.sh), and
# this is the round that visits them: it hands each one today's facts about ITS item and
# collects what comes back, verbatim, into contributions.json.
#
# The reporter does not write these. It assembles them, and decides one thing of its own - what
# to act on first - after everybody has reported.
#
#   issue-round.sh <run-dir>
#
# THE CLASS IS COMPUTED HERE, not asked of an agent. ACT_NOW / FOLLOW_UP / WAITING / TRACKED is
# a lookup on precomputed fields with "first match wins" - one right answer, no judgement in it.
# Thirty agents each applying that table to their own item would drift, invisibly, because each
# one only ever sees its own item. So the arithmetic is done once, in code, and handed to the
# agent as a fact. What is left for the agent is what only it can know: what changed since it
# last looked, and what it recommends.
#
# Sequential on purpose. These share one pod with no resource limits, on the node that runs
# Rancher, and a herd of claudes is how that node has been taken down before.
set -e

DIR=${1:?issue-round.sh needs the run directory}
[ -f "$DIR/data.json" ] || { echo "issue-round.sh: no data.json in $DIR" >&2; exit 2; }

ROOT=$(dirname "$0")
AGENT="$ROOT/issue-agent.sh"
[ -x "$AGENT" ] || AGENT="sh $ROOT/issue-agent.sh"

WORK="$DIR/issue-round"
mkdir -p "$WORK"

# One file per item: its data, its computed class, and the shape of the answer wanted back.
node -e '
const fs = require("fs");
const [dataPath, workDir] = process.argv.slice(1);
const d = JSON.parse(fs.readFileSync(dataPath, "utf8"));

// The rule table, as code. Order matters: first match wins.
function githubClass(i) {
  if (i.tracked) return { cls: "TRACKED", rule: "github.1 tracked" };
  if (i.ball === "ours") return { cls: "ACT_NOW", rule: "github.2 ball is ours" };
  if (i.ball === "reporter" && i.idle_days >= 14) return { cls: "FOLLOW_UP", rule: "github.3 reporter, idle >= 14" };
  if (i.ball === "reporter") return { cls: "WAITING", rule: "github.4 reporter, idle < 14" };

  return { cls: "ACT_NOW", rule: "github.fallback" };
}

// Jira, mirroring the prompt\u2019s own list, first match wins:
//   1. last comment from the reporter/external, or no comments  -> ACT_NOW (we owe the move)
//   2. we commented last, OR status is Waiting for Reporter      -> FOLLOW_UP >= 14d, else WAITING
//   3. assigned AND a GH issue/PR moving                         -> TRACKED
//
// The honest caveat: rule 1 needs to know whether the last commenter is one of US, and Jira
// items carry no association field the way GitHub ones do. The mechanical proxy is
// `last_comment_author === reporter`, which is right whenever the reporter is the one who
// spoke, and treats an unrelated third party as if they were us. So the matched rule is
// recorded beside the class, and an agent that thinks its item is misclassified says so in
// `class_dispute` rather than quietly using a different one - a disagreement anybody can see
// beats a drift nobody can.
function jiraClass(t) {
  const waitingForReporter = /waiting for reporter/i.test(t.status || "");
  const reporterSpokeLast = !!t.last_comment_author && t.last_comment_author === t.reporter;
  const assignedAndMoving = !!t.github_issue && !!t.assignee && t.assignee !== "Unassigned";

  if (!t.comments_count || reporterSpokeLast) {
    return { cls: "ACT_NOW", rule: "jira.1 reporter spoke last or no comments" };
  }

  if (waitingForReporter || t.last_comment_author) {
    return t.idle_days >= 14
      ? { cls: "FOLLOW_UP", rule: "jira.2 ours/waiting-for-reporter, idle >= 14" }
      : { cls: "WAITING", rule: "jira.2 ours/waiting-for-reporter, idle < 14" };
  }

  if (assignedAndMoving) {
    return { cls: "TRACKED", rule: "jira.3 assigned and a GH issue moving" };
  }

  return { cls: "ACT_NOW", rule: "jira.fallback" };
}

// What this item looked like the last time its agent saw it. An agent that remembers the
// ticket does not need the description and twenty-four comments again - it needs what is NEW.
// Re-sending everything every day would pay for the memory and then not use it.
function lastSeen(ref) {
  const slug = ref.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  const file = `${ process.env.ISSUE_AGENT_ROOT || "/workspace/idr-issues" }/${ slug }/last-seen.json`;

  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const items = [];

for (const i of d.github?.external_issues?.issues || []) {
  items.push({ ref: `#${ i.number }`, kind: "github", group: "issues", ...githubClass(i), item: i });
}
for (const i of d.github?.questions?.issues || []) {
  items.push({ ref: `#${ i.number }`, kind: "github", group: "questions", ...githubClass(i), item: i });
}
for (const [group, arr] of Object.entries(d.jira || {})) {
  for (const t of (Array.isArray(arr) ? arr : arr?.issues || [])) {
    items.push({ ref: t.key, kind: "jira", group, ...jiraClass(t), item: t });
  }
}

fs.writeFileSync(`${ workDir }/items.json`, JSON.stringify(items));

// The prompt each agent gets. Its own item and nothing else: an agent that could see the
// whole board would start reporting on items that are not its own.
for (const [n, it] of items.entries()) {
  const seen = lastSeen(it.ref);
  const i = it.item;
  const comments = Array.isArray(i.comments) ? i.comments : [];
  const fresh = seen
    ? comments.filter((c) => !seen.last_comment_at || String(c.created || c.created_at || "") > seen.last_comment_at)
    : comments;

  // First look gets everything. Every look after it gets the delta and nothing else: the agent
  // is the one carrying the history, which is the whole reason it exists.
  const payload = seen ? {
    ref:          it.ref,
    status:       i.status || (i.tracked ? "tracked" : undefined),
    status_was:   seen.status,
    idle_days:    i.idle_days,
    new_comments: fresh,
    nothing_new:  !fresh.length && i.status === seen.status,
  } : i;

  const lines = [
    `You are the standing agent for ${ it.kind === "jira" ? "Jira ticket" : "GitHub issue" } ${ it.ref }.`,
    `Today is ${ d.report_date }. You may have looked at this item on earlier days; if so, say what CHANGED.`,
    "",
    seen
      ? "What is NEW since you last looked (you already know the rest - do not ask for it):"
      : "Today\u2019s data for your item (this is your first look at it):",
    "```json",
    JSON.stringify(payload, null, 1),
    "```",
    "",
    `Its class today is **${ it.cls }** (rule: ${ it.rule }). That is computed from the data, not your`,
    "decision - use it. If you believe it is wrong, say so in class_dispute; do not use a different one.",
    "",
    "Reply with ONE json object and nothing else - no fence, no commentary:",
    "",
    JSON.stringify({
      ref:            it.ref,
      headline:       "one short line: the state of this item today",
      changed:        "what changed since you last looked, or \"first look\" if this is the first",
      why:            "one or two sentences: why this matters today",
      recommendation: "the concrete next move we owe, in one line",
      draft:          "optional: a reply you would send, or empty",
      class_dispute:  "empty, OR one line if you believe the computed class is wrong and why",
    }, null, 1),
    "",
    "Keep it factual and short. Do not invent activity that is not in the data.",
  ];

  fs.writeFileSync(`${ workDir }/${ String(n).padStart(3, "0") }.prompt`, lines.join("\n"));
}

process.stderr.write(`issue-round: ${ items.length } items\n`);
' "$DIR/data.json" "$WORK"

# Ask each one, in turn. A failure is recorded against that item rather than ending the round:
# one agent that times out should cost one contribution, not the report.
node -e '
const fs = require("fs");
const { execFileSync } = require("child_process");
const [workDir, agent] = process.argv.slice(1);
const items = JSON.parse(fs.readFileSync(`${ workDir }/items.json`, "utf8"));
const out = {};

for (const [n, it] of items.entries()) {
  const prompt = `${ workDir }/${ String(n).padStart(3, "0") }.prompt`;
  const argv = agent.split(" ").concat(["ask", it.ref, prompt]);

  process.stderr.write(`issue-round: ${ it.ref } (${ n + 1 }/${ items.length }) ${ it.cls }\n`);

  try {
    const answer = execFileSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 600000 });
    const match = answer.match(/\{[\s\S]*\}/);

    out[it.ref] = {
      ...it, ok: true, contribution: match ? JSON.parse(match[0]) : null, raw: match ? undefined : answer.slice(0, 500),
    };

    // Only after it answered. A turn that failed did not see today, so tomorrow should still
    // offer it what it missed rather than skip straight past.
    const slug = it.ref.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    const dir = `${ process.env.ISSUE_AGENT_ROOT || "/workspace/idr-issues" }/${ slug }`;

    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${ dir }/last-seen.json`, JSON.stringify({
        at:               new Date().toISOString(),
        status:           it.item.status || null,
        idle_days:        it.item.idle_days ?? null,
        comments_count:   it.item.comments_count ?? null,
        last_comment_at:  it.item.last_comment_at || null,
      }));
    } catch { /* the agent answered; failing to note it is not worth losing that */ }
  } catch (e) {
    out[it.ref] = { ...it, ok: false, error: String(e.message || e).slice(0, 300) };
    process.stderr.write(`issue-round: ${ it.ref } FAILED - ${ out[it.ref].error }\n`);
  }
}

fs.writeFileSync(`${ workDir }/../contributions.json`, JSON.stringify(out, null, 1));
process.stderr.write(`issue-round: wrote contributions.json (${ Object.values(out).filter((x) => x.ok).length }/${ items.length } answered)\n`);
' "$WORK" "$AGENT"
