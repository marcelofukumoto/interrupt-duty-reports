#!/usr/bin/env node
// Gather the day's interrupt-duty data: the three active Jira queues and the recent
// rancher/dashboard community issues, as one JSON file for the report to analyse.
//
// Deliberately dependency-free and shell-free. This runs inside the agent pod, which is a
// stock `node:24` with no `jq` and no `gh` in it, so the pipeline the team runs on a laptop
// (scripts/gather-all-data.sh) is re-expressed here in the one runtime the pod is guaranteed
// to have. The derived fields - age, idle, who has the ball, whether an issue is tracked -
// keep the names and the rules the report prompt reads them by, because the prompt is shared
// with that pipeline and a renamed field is a report that silently loses a section.
//
// Credentials come from the environment, never from a command line: this is exec'd in a pod
// where `ps` is readable, and a token in argv is a token on display.

import { readFileSync, writeFileSync } from 'node:fs';

const JIRA_BASE = process.env.JIRA_BASE_URL || 'https://jira.suse.com';
const REPO_OWNER = process.env.GH_OWNER || 'rancher';
const REPO_NAME = process.env.GH_REPO || 'dashboard';
const OUT = process.env.OUT || './data.json';

// The daily window. The report covers Jira's active queues in full and only the last 30 days
// of community issues; everything older belongs to the separate backlog processes.
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 30);

// The two tokens, read from a file named by CREDS_FILE rather than from the environment.
//
// A pod is a place where `ps` and `/proc/<pid>/environ` are readable, and this one is shared:
// every conversation in it runs as the same user. A token on a command line or in an exported
// variable is a token every pane in the pod can read for as long as the process lives. The file
// is written 0600 by the extension, read here once, and removed by publish.sh when the run ends.
function credentials() {
  const file = process.env.CREDS_FILE;

  if (!file) {
    return { JIRA_PAT: process.env.JIRA_PAT || '', GH_TOKEN: process.env.GH_TOKEN || '' };
  }

  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`could not read the credentials at ${ file }: ${ e?.message || e }`);
  }
}

const TEAM = 'UI';

function fail(message) {
  process.stderr.write(`gather: ${ message }\n`);
  process.exit(1);
}

const { JIRA_PAT, GH_TOKEN } = credentials();

if (!JIRA_PAT) {
  fail('JIRA_PAT is not set. The three Jira queues cannot be read without it.');
}
if (!GH_TOKEN) {
  fail('GH_TOKEN is not set. The community issues cannot be read without it.');
}

const now = Date.now();

/** Whole days between an ISO timestamp and now, floored - the unit every age in the report is in. */
function daysSince(iso) {
  if (!iso) {
    return null;
  }

  // Jira stamps offsets without a colon (2026-09-02T11:20:31.000+0000), which Date rejects on
  // some runtimes; normalise to the form it always accepts.
  const normalised = String(iso).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const then = Date.parse(normalised);

  return Number.isNaN(then) ? null : Math.floor((now - then) / 86400000);
}

async function request(url, init, what) {
  let resp;

  try {
    resp = await fetch(url, init);
  } catch (e) {
    throw new Error(`${ what }: ${ e?.message || e }`, { cause: e });
  }

  const text = await resp.text();

  if (!resp.ok) {
    // The body is where an expired PAT actually says so, but it can be an HTML login page -
    // so it is trimmed rather than printed whole.
    const detail = text.slice(0, 300).replace(/\s+/g, ' ').trim();

    throw new Error(`${ what }: HTTP ${ resp.status }${ detail ? ` - ${ detail }` : '' }`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${ what }: the answer was not JSON`);
  }
}

// ── Jira ───────────────────────────────────────────────────────────────────────────────────

const JIRA_FIELDS = [
  'key', 'summary', 'status', 'issuetype', 'assignee', 'priority', 'created', 'updated',
  'reporter', 'description', 'comment', 'components', 'labels', 'issuelinks', 'resolution',
  'versions', 'customfield_21300', 'customfield_23900', 'customfield_23901', 'customfield_24000',
];

async function queryJira(jql) {
  const body = await request(`${ JIRA_BASE }/rest/api/2/search`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${ JIRA_PAT }`,
      'Content-Type': 'application/json',
      Accept:         'application/json',
    },
    body: JSON.stringify({ jql, maxResults: 100, fields: JIRA_FIELDS }),
  }, 'Jira search');

  return body.issues || [];
}

/** The multi-select custom fields come back as objects; the report only ever wants their values. */
function values(field) {
  return (field || []).map((entry) => entry?.value).filter(Boolean);
}

function normaliseJira(issues) {
  return issues.map((issue) => {
    const f = issue.fields || {};
    const comments = f.comment?.comments || [];
    const last = comments[comments.length - 1] || null;

    return {
      key:         issue.key,
      url:         `${ JIRA_BASE }/browse/${ issue.key }`,
      summary:     f.summary,
      status:      f.status?.name || null,
      type:        f.issuetype?.name || null,
      priority:    f.priority?.name || null,
      assignee:    f.assignee?.displayName || null,
      reporter:    f.reporter?.displayName || null,
      created:     f.created,
      updated:     f.updated,
      age_days:    daysSince(f.created),
      // Idle is measured from the last comment when there is one, and from the ticket's own
      // updated stamp when there is not. The report's nudge rule is "idle >= 14 days since we
      // replied", which is a fact about the conversation, and a field edit is not a reply.
      idle_days:   daysSince(last?.created || f.updated),
      description: f.description || '',
      // The last three, which is what the prompt reads to decide who owes the next move. The
      // whole thread would be most of this file for no gain.
      comments:    comments.slice(-3).map((c) => ({
        author:  c.author?.displayName || null,
        created: c.created,
        body:    c.body || '',
      })),
      comments_count:      comments.length,
      last_comment_author: last?.author?.displayName || null,
      last_comment_at:     last?.created || null,
      labels:              f.labels || [],
      components:          (f.components || []).map((c) => c.name),
      affects_versions:    (f.versions || []).map((v) => v.name),
      github_issue:        f.customfield_21300 ?? null,
      rancher_team:        values(f.customfield_23900),
      account_name:        values(f.customfield_23901),
      support_cases:       f.customfield_24000 || [],
      linked_issues:       (f.issuelinks || []).map((link) => ({
        type:    link.type?.name || null,
        key:     link.inwardIssue?.key || link.outwardIssue?.key || null,
        summary: link.inwardIssue?.fields?.summary || link.outwardIssue?.fields?.summary || null,
      })).filter((l) => l.key),
    };
  });
}

// The three ACTIVE queues, and only those. The To Do / escalation backlog belongs to the
// jira-issues-development process and the report explicitly does not cover it.
const JIRA_QUERIES = {
  new_bugs:         `project = SURE AND type = Bug AND resolution = Unresolved AND "Rancher Team" = ${ TEAM } AND status = New ORDER BY priority`,
  in_triage:        `project = SURE AND type = Bug AND resolution = Unresolved AND "Rancher Team" = ${ TEAM } AND (Status = "In Triage") AND (component IS EMPTY OR component not in (Harvester)) ORDER BY priority, created ASC`,
  waiting_reporter: `project = SURE AND type = Bug AND resolution = Unresolved AND "Rancher Team" = ${ TEAM } AND status = "Waiting for Reporter" ORDER BY priority, created ASC`,
};

// ── GitHub ─────────────────────────────────────────────────────────────────────────────────

const INTERNAL = new Set(['MEMBER', 'OWNER', 'COLLABORATOR']);

const ISSUES_QUERY = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: 100, after: $cursor, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url createdAt updatedAt authorAssociation
        author { login __typename }
        assignees { totalCount }
        comments(last: 1) { totalCount nodes { authorAssociation createdAt author { login __typename } } }
        labels(first: 20) { nodes { name } }
        timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 10) {
          nodes { ... on CrossReferencedEvent { source { ... on PullRequest { number state url } } } }
        }
        body
      }
    }
  }
}`;

async function graphql(query, variables) {
  const body = await request('https://api.github.com/graphql', {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${ GH_TOKEN }`,
      'Content-Type': 'application/json',
      Accept:         'application/json',
      'User-Agent':   'interrupt-duty-reports',
    },
    body: JSON.stringify({ query, variables }),
  }, 'GitHub GraphQL');

  if (body.errors?.length) {
    throw new Error(`GitHub GraphQL: ${ body.errors.map((e) => e.message).join('; ') }`);
  }

  return body.data;
}

/**
 * Every open issue created inside the window, newest first.
 *
 * Ordered by creation and stopped at the cutoff rather than filtered after the fact: the repo
 * has thousands of open issues and the report wants the last thirty days of them. Ordering by
 * update instead - which the laptop pipeline does, because it wants the whole set - would mean
 * no page could ever be the last one.
 *
 * The listing rather than the search index, because the index lags by minutes and a
 * minutes-old issue with no comments on it is precisely the ACT NOW case the report exists to
 * surface.
 */
async function fetchRecentIssues(cutoffMs) {
  const nodes = [];
  let cursor = null;

  for (let page = 0; page < 30; page++) {
    const data = await graphql(ISSUES_QUERY, { owner: REPO_OWNER, name: REPO_NAME, cursor });
    const conn = data?.repository?.issues;

    if (!conn) {
      break;
    }

    let reachedCutoff = false;

    for (const node of conn.nodes || []) {
      if (Date.parse(node.createdAt) < cutoffMs) {
        reachedCutoff = true;
        break;
      }
      nodes.push(node);
    }

    if (reachedCutoff || !conn.pageInfo?.hasNextPage) {
      break;
    }

    cursor = conn.pageInfo.endCursor;
  }

  return nodes;
}

function normaliseIssue(node) {
  const lastComment = node.comments?.nodes?.[0] || null;
  const labels = (node.labels?.nodes || []).map((l) => l.name);
  const linkedPrs = (node.timelineItems?.nodes || [])
    .map((t) => t.source)
    .filter((s) => s && typeof s.number === 'number')
    .map((s) => ({ number: s.number, state: s.state, url: s.url }));
  const hasLinkedPr = linkedPrs.some((pr) => pr.state === 'OPEN' || pr.state === 'MERGED');
  const hasAssignee = (node.assignees?.totalCount || 0) > 0;

  // Who owes the next move. No comments at all is ours by definition - somebody external is
  // waiting on a first response. A bot's comment is automation, not an answer, so it leaves
  // the ball where it was; anything from a member/owner/collaborator hands it to the reporter.
  let ball = 'ours';

  if ((node.comments?.totalCount || 0) > 0 && lastComment) {
    if (lastComment.author?.__typename !== 'Bot' && INTERNAL.has(lastComment.authorAssociation)) {
      ball = 'reporter';
    }
  }

  return {
    number:                   node.number,
    url:                      node.url,
    title:                    node.title,
    author:                   node.author?.login || null,
    author_association:       node.authorAssociation,
    created_at:               node.createdAt,
    updated_at:               node.updatedAt,
    age_days:                 daysSince(node.createdAt),
    idle_days:                daysSince(node.updatedAt),
    comments_count:           node.comments?.totalCount || 0,
    last_comment_association: lastComment?.authorAssociation || null,
    last_comment_author:      lastComment?.author?.login || null,
    last_comment_at:          lastComment?.createdAt || null,
    has_assignee:             hasAssignee,
    labels,
    is_question:              labels.includes('kind/question'),
    linked_prs:               linkedPrs,
    has_linked_pr:            hasLinkedPr,
    ball,
    tracked:                  hasAssignee || hasLinkedPr,
    body:                     (node.body || '').slice(0, 2000),
  };
}

/** Community, not us and not automation - the set the report calls "external". */
function isCommunity(node) {
  return !INTERNAL.has(node.authorAssociation) && node.author?.__typename !== 'Bot';
}

// ── Run ────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const reportDate = new Date(now).toISOString().slice(0, 10);
  const cutoffMs = now - (WINDOW_DAYS * 86400000);

  process.stderr.write('=== Gathering Jira data ===\n');

  const jira = {};

  for (const [name, jql] of Object.entries(JIRA_QUERIES)) {
    process.stderr.write(`  ${ name }...\n`);
    const issues = normaliseJira(await queryJira(jql));

    jira[name] = { count: issues.length, issues };
  }

  process.stderr.write('=== Gathering GitHub data ===\n');
  process.stderr.write(`  community issues created in the last ${ WINDOW_DAYS }d...\n`);

  const raw = await fetchRecentIssues(cutoffMs);
  const issues = raw.filter(isCommunity).map(normaliseIssue);

  // Questions are answered in their own section of the report, so they are separated here
  // rather than by a filter the prompt has to remember to apply.
  const questions = issues.filter((i) => i.is_question);
  const needsAttention = issues.filter((i) => !i.is_question);

  const output = {
    report_date:  reportDate,
    generated_at: new Date(now).toISOString(),
    window_days:  WINDOW_DAYS,
    source:       {
      jira_base_url: JIRA_BASE,
      github_repo:   `${ REPO_OWNER }/${ REPO_NAME }`,
    },
    jira,
    github: {
      external_issues: {
        count:      needsAttention.length,
        act_now:    needsAttention.filter((i) => i.ball === 'ours' && !i.tracked).length,
        follow_up:  needsAttention.filter((i) => i.ball === 'reporter' && i.idle_days >= 14 && !i.tracked).length,
        waiting:    needsAttention.filter((i) => i.ball === 'reporter' && i.idle_days < 14 && !i.tracked).length,
        tracked:    needsAttention.filter((i) => i.tracked).length,
        issues:     needsAttention,
      },
      questions: { count: questions.length, issues: questions },
    },
  };

  writeFileSync(OUT, `${ JSON.stringify(output, null, 2) }\n`);

  process.stderr.write('=== Done ===\n');
  process.stderr.write(`Data written to ${ OUT }\n`);
  process.stderr.write(`  Jira: ${ jira.new_bugs.count } new, ${ jira.in_triage.count } in triage, ${ jira.waiting_reporter.count } waiting for reporter\n`);
  process.stderr.write(`  GitHub: ${ needsAttention.length } community issues (<=${ WINDOW_DAYS }d), ${ questions.length } questions\n`);
}

main().catch((e) => fail(e?.message || String(e)));
