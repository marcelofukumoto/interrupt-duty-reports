// Generating one daily report, from the button to the row in the list.
//
// The shape of a run, and why it is this shape:
//
//   1. a summary ConfigMap is written first, saying `running`. A run that dies before the agent
//      is even asked still has a row that says so.
//   2. the scripts this extension carries are written into the agent pod. They are not in the
//      pod already - the pod belongs to the agents extension and is made from its seed, not
//      ours - so every run puts the current copy there.
//   3. the two tokens go in beside them, 0600, as a file. Never as a prompt, never on a
//      command line, and never in the pod's environment: the pane and the report share one pod
//      and one user.
//   4. a conversation is started in the agent pod with an opening prompt, and its pane is
//      started detached. The prompt is short and points at the spec; the spec is the file.
//   5. the agent runs the gather, writes report.json, and calls publish.sh, which is what
//      actually puts the report in the cluster. The page watches the ConfigMap.
//
// Everything deterministic is in a script (run.sh, publish.sh) and everything judged is in the
// prompt. The agent's job starts at data.json and stops at report.json; neither end of that is
// left to it to improvise.
import { AGENT_PROJECT, agentsApi } from './agents';
import { podExec, podRunScript, podWriteFile, shellQuote } from './exec';
import type { PodRef } from './exec';
import { createRunning, setStatus, updateMeta } from './store';
import { SEED_FILES } from '../seed.generated';
import type { ReportMeta } from '../types';

/** Where this extension keeps its scripts and its runs inside the agent pod. */
const ROOT = '/workspace/.interrupt-duty';

/** The agent pod's own user. Everything the pane touches has to belong to it. */
const POD_USER = '1000:1000';

/** Where every conversation in the agent pod runs, and the home it runs with. */
const CONVERSATIONS = '/workspace/conversations';
const AGENT_HOME = '/workspace/.home';

export interface Credentials {
  jiraPat: string;
  ghToken: string;
}

export interface StartedRun {
  id: string;
  session: string;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * The report's id, which is also both ConfigMap names and a Kubernetes label value.
 *
 * Date first so that sorting the names sorts them by age, which is what publish.sh's prune
 * relies on; the time so that two runs on one day are two reports rather than one overwriting
 * the other.
 */
function idAndDate(now: Date): { id: string; date: string } {
  const date = `${ now.getUTCFullYear() }-${ pad(now.getUTCMonth() + 1) }-${ pad(now.getUTCDate()) }`;
  const time = `${ pad(now.getUTCHours()) }${ pad(now.getUTCMinutes()) }${ pad(now.getUTCSeconds()) }`;

  return { id: `daily-${ date }-${ time }`, date };
}

/**
 * What the conversation opens with.
 *
 * Deliberately short. Everything about what a report *is* lives in the spec file, which is the
 * same document the team's own daily-report prompt is - so the report does not quietly drift
 * from the one the engineer is used to reading just because somebody edited a string in a Vue
 * component. This says where things are and what order to do them in, and nothing else.
 *
 * It carries no credentials. They are already in the run directory, and the gather reads them
 * from there - so this text, which ends up in a transcript and on a terminal somebody may be
 * watching, has nothing in it worth hiding.
 */
function openingPrompt(runDir: string, id: string, date: string): string {
  return [
    `Generate the Rancher UI interrupt-duty daily report for ${ date }.`,
    '',
    `Your run directory is ${ runDir }. Work only in there.`,
    '',
    'Do these four steps in order, without stopping to ask anything:',
    '',
    `1. Gather the data:  sh ${ ROOT }/run.sh ${ runDir }`,
    `   It writes ${ runDir }/data.json. It already has the credentials it needs - do not look`,
    '   for them, do not ask for them, and do not print them.',
    '',
    `2. Read ${ ROOT }/daily-report.prompt.md IN FULL. It is the report specification and it is`,
    '   authoritative: the classes, the readiness gate, the next-step verbs, the suggested',
    '   comments and the exact JSON shape all come from it.',
    '',
    `3. Read ${ runDir }/data.json and write ${ runDir }/report.json following that spec.`,
    '   report.json must be a single JSON document and nothing else: no markdown fence, no',
    '   commentary around it. Every group array must be present even when it is empty.',
    '',
    `4. Publish it:  sh ${ ROOT }/publish.sh ${ runDir } ${ id } done`,
    '',
    'If a step fails and you cannot recover, do not leave the run hanging - record the failure:',
    `   sh ${ ROOT }/publish.sh ${ runDir } ${ id } fail "one line saying what went wrong"`,
    '',
    'Then stop. Do not open a pull request, do not write markdown, do not touch anything',
    'outside your run directory.',
  ].join('\n');
}

function agentTarget(pod: string): PodRef {
  const api = agentsApi();

  return {
    pod,
    namespace: api?.agent.namespace || 'extension-studio',
    container: api?.agent.container || 'agent',
  };
}

/**
 * Put this extension's scripts in the pod.
 *
 * Every run, rather than once. The pod is replaced whenever the agents extension rolls it, and
 * a run against last month's copy of the gather is a run whose output does not match the spec
 * the same bundle carries. Writing three small files is cheaper than the bug.
 */
async function writeSeed(target: PodRef): Promise<void> {
  for (const name of ['gather.mjs', 'run.sh', 'publish.sh', 'daily-report.prompt.md']) {
    const content = SEED_FILES[name];

    if (!content) {
      throw new Error(`This build is missing its ${ name } - run "yarn gen-seed" and rebuild.`);
    }

    await podWriteFile(target, `${ ROOT }/${ name }`, content, { mode: '644', owner: POD_USER });
  }

  // The directory itself, so the pane (which is not root) can make its own run directories in it.
  await podExec(target, ['/bin/sh', '-c', `chown ${ POD_USER } ${ ROOT } 2>/dev/null || true`], { timeoutMs: 15000 });
}

/**
 * Start a report.
 *
 * Throws with something a person can act on rather than leaving a half-made run behind: if
 * anything after the summary ConfigMap fails, the summary is marked failed on the way out, so
 * the list shows what happened instead of a row stuck on "running" forever.
 */
export async function startRun(credentials: Credentials, startedBy?: string): Promise<StartedRun> {
  const api = agentsApi();

  if (!api) {
    throw new Error('The Agents extension is not available on this page, so there is no agent to run the report.');
  }

  const pod = await api.agent.pod();

  if (!pod) {
    throw new Error('The agent pod is not running, so there is nowhere to run the report.');
  }

  const { id, date } = idAndDate(new Date());
  const target = agentTarget(pod);
  const runDir = `${ ROOT }/${ id }`;

  const meta: ReportMeta = {
    id,
    reportDate: date,
    status:     'running',
    startedAt:  new Date().toISOString(),
    startedBy,
  };

  await createRunning(meta);

  try {
    await writeSeed(target);

    // The run directory, owned by the pane's user, because the agent writes report.json into it.
    await podRunScript(
      target,
      `mkdir -p ${ shellQuote(runDir) } && chown ${ POD_USER } ${ shellQuote(runDir) }`,
      'make the run directory in the agent pod',
      20000,
    );

    // meta.json travels with the run so publish.sh can finish it without being told the date,
    // who started it, or when.
    await podWriteFile(target, `${ runDir }/meta.json`, JSON.stringify(meta), { mode: '644', owner: POD_USER });

    // 0600 and owned by the pane's user: read once by the gather, removed by publish.sh.
    await podWriteFile(
      target,
      `${ runDir }/creds.json`,
      JSON.stringify({ JIRA_PAT: credentials.jiraPat, GH_TOKEN: credentials.ghToken }),
      { mode: '600', owner: POD_USER },
    );

    const session = await api.agent.startInProject(
      AGENT_PROJECT,
      `Daily report ${ date }`,
      openingPrompt(runDir, id, date),
    );

    await updateMeta(id, (current) => ({ ...current, session }));

    // Start the pane detached. Starting a conversation only queues the prompt - it is read the
    // first time a pane attaches, and without this nothing would attach until somebody opened
    // the terminal by hand, which is not what pressing Generate means.
    await podRunScript(
      target,
      `/bin/sh /seed/shell.sh ${ shellQuote(session) } ${ shellQuote(CONVERSATIONS) } ${ shellQuote(AGENT_HOME) } start`,
      'start the conversation in the agent pod',
      120000,
    );

    return { id, session };
  } catch (e: any) {
    const why = e?.message || String(e);

    await setStatus(id, 'failed', why).catch(() => undefined);
    // The tokens do not stay behind on a run that never got going.
    await podExec(target, ['/bin/sh', '-c', `rm -f ${ shellQuote(`${ runDir }/creds.json`) }`], { timeoutMs: 15000 }).catch(() => undefined);

    throw new Error(why, { cause: e });
  }
}

/**
 * Stop a run.
 *
 * Ending the conversation is what actually stops the work - it kills the tmux session the pane
 * runs in, so the claude inside it goes with it. The rest is tidying: the row says cancelled
 * rather than sitting on "running" for ever, and the tokens go, because publish.sh is the thing
 * that would have removed them and it is not going to be called now.
 */
export async function stopRun(meta: ReportMeta): Promise<void> {
  const api = agentsApi();

  if (api && meta.session) {
    await api.agent.end(meta.session).catch(() => undefined);
  }

  const pod = await api?.agent.pod().catch(() => null);

  if (pod) {
    const target = agentTarget(pod);

    await podExec(
      target,
      ['/bin/sh', '-c', `rm -f ${ shellQuote(`${ ROOT }/${ meta.id }/creds.json`) }`],
      { timeoutMs: 15000 },
    ).catch(() => undefined);
  }

  await setStatus(meta.id, 'cancelled', 'Stopped from the reports page.');
}

/**
 * End the conversations of runs that are over, and delete what they left in the pod.
 *
 * A conversation does not end when the work in it does. claude-session.sh runs claude in a
 * loop so that a pane survives a crash, which means a finished report leaves a tmux session
 * with an idle claude in it - and a hundred reports would leave a hundred of them in one pod,
 * along with a hundred run directories of gathered JSON.
 *
 * So this is the other half of a run, and it is a sweep rather than a step at the end of one:
 * the run that matters most to clean up is the one whose browser tab was closed while it was
 * finishing, and that run has nothing left to execute a final step. It takes the sessions that
 * are still in flight and ends everything else this extension started.
 */
export async function sweepFinishedRuns(activeSessions: string[]): Promise<number> {
  const api = agentsApi();

  if (!api) {
    return 0;
  }

  const keep = new Set(activeSessions.filter(Boolean));
  const sessions = await api.agent.projectSessions(AGENT_PROJECT).catch(() => []);
  let ended = 0;

  for (const session of sessions) {
    if (keep.has(session.id)) {
      continue;
    }

    await api.agent.end(session.id).catch(() => undefined);
    ended++;
  }

  return ended;
}

/**
 * Remove the run directories of reports that no longer exist.
 *
 * Driven from the ids that are still stored rather than from a date: a run directory is worth
 * keeping exactly as long as the report it produced is in the list, and the list is capped, so
 * this is what stops the pod's disk growing with it. A run that failed leaves a directory and
 * a summary, and is cleaned up when that summary is deleted.
 */
export async function sweepRunDirectories(keepIds: string[]): Promise<void> {
  const api = agentsApi();
  const pod = await api?.agent.pod().catch(() => null);

  if (!pod) {
    return;
  }

  const keep = keepIds.filter((id) => /^[a-z0-9][a-z0-9-]*$/.test(id));
  const keepList = keep.map(shellQuote).join(' ');
  // Built as a list of names to keep rather than a list to delete, so a directory this page has
  // never heard of - a run from a browser that has since been closed - is cleaned up too.
  const script = [
    `cd ${ shellQuote(ROOT) } 2>/dev/null || exit 0`,
    `for dir in daily-*; do`,
    `  [ -d "$dir" ] || continue`,
    `  keep=no`,
    keepList ? `  for id in ${ keepList }; do [ "$dir" = "$id" ] && keep=yes; done` : '  :',
    `  [ "$keep" = yes ] || rm -rf "$dir"`,
    'done',
  ].join('\n');

  await podExec(agentTarget(pod), ['/bin/sh', '-c', script], { timeoutMs: 30000 }).catch(() => undefined);
}

/**
 * Where a run has got to.
 *
 * Read off the run directory rather than off the terminal, and that is the whole point. The
 * pane's last few lines are whatever claude happened to print - a tool call, a token count, a
 * half-drawn spinner - which is honest but says nothing about progress, and reading progress
 * out of prose is guessing. The three files a run produces say it exactly: the gather writes
 * data.json, the agent writes report.json, publish.sh removes creds.json on its way out.
 */
export type RunPhase = 'starting' | 'gathering' | 'analysing' | 'publishing';

export interface RunProgress {
  phase: RunPhase;
  /** The pane's last few lines, kept as detail somebody can open rather than as the headline. */
  output: string;
}

export const RUN_PHASES: RunPhase[] = ['starting', 'gathering', 'analysing', 'publishing'];

export async function runProgress(meta: ReportMeta, lines = 12): Promise<RunProgress> {
  const api = agentsApi();

  if (!api || !meta.session) {
    return { phase: 'starting', output: '' };
  }

  const pod = await api.agent.pod().catch(() => null);

  // Asked together: one of these is a directory listing and the other is a terminal capture,
  // and a person is watching both change.
  const [listing, pane] = await Promise.all([
    pod
      ? podExec(
        agentTarget(pod),
        ['/bin/sh', '-c', `ls -1 ${ shellQuote(`${ ROOT }/${ meta.id }`) } 2>/dev/null`],
        { timeoutMs: 15000 },
      ).catch(() => null)
      : Promise.resolve(null),
    api.agent.pane(meta.session, lines).catch(() => null),
  ]);

  const files = new Set((listing?.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean));

  let phase: RunPhase = 'starting';

  if (files.has('report.json')) {
    phase = 'publishing';
  } else if (files.has('data.json')) {
    phase = 'analysing';
  } else if (files.has('meta.json')) {
    phase = 'gathering';
  }

  const output = pane?.running
    ? pane.text.split('\n').map((l) => l.trim()).filter(Boolean).slice(-6).join('\n')
    : '';

  return { phase, output };
}
