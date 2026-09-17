// Reaching one item's standing agent from the browser.
//
// Every item in a report has an agent of its own that has followed it across every report it
// appeared in. The round talks to them on the way past; this is how a person does, from the
// item's own card, and says something the next report will then take into account - because a
// chat and a round resume the SAME conversation, so what is said here is simply there
// tomorrow. That is the point of it rather than a side effect.
import { podExec } from './exec';
import type { PodRef } from './exec';

/** Where the seed writes issue-agent.sh, and where the agents keep their directories. */
const ROOT = '/workspace/.interrupt-duty';
const CLAUDE = '/workspace/.home/.local/bin/claude';

async function say(target: PodRef, args: string[]): Promise<string> {
  const result = await podExec(target, ['/bin/sh', `${ ROOT }/issue-agent.sh`, ...args], { timeoutMs: 20000 });

  return (result.stdout || '').trim();
}

/** The claude session an item's agent keeps, or '' when it has never been asked about. */
export function issueSession(target: PodRef, key: string): Promise<string> {
  return say(target, ['id', key]).catch(() => '');
}

/** Where that agent lives - one directory per item, which is what makes its transcript its own. */
export function issueDir(target: PodRef, key: string): Promise<string> {
  return say(target, ['dir', key]).catch(() => '');
}

/** True while somebody has this agent's chat open, so the round should leave it alone. */
export async function issueBusy(target: PodRef, key: string): Promise<boolean> {
  return (await say(target, ['busy', key]).catch(() => '')) === 'busy';
}

/**
 * The argv a terminal runs to talk to one item's agent.
 *
 * Not `agent.command(id)` - that builds a pane for one of the agents panel's own conversations,
 * and an issue agent is deliberately not one of those: it is a plain claude session in a
 * directory of its own, which is what makes "which transcript is this" have a single answer.
 * So this is the terminal component's other mode, a raw argv.
 *
 * `setpriv` because an exec into the pod lands as root and claude refuses
 * --dangerously-skip-permissions as root. `--resume` by name rather than `--continue`, which
 * would pick up whatever was touched last in the directory.
 */
export function issueTerminalCommand(dir: string, session: string): string[] {
  const resume = session ? ` --resume ${ session }` : '';

  return [
    'setpriv', '--reuid=1000', '--regid=1000', '--init-groups',
    '/usr/bin/env', 'HOME=/workspace/.home', `PATH=/workspace/.home/.local/bin:${ '/usr/local/bin:/usr/bin:/bin' }`,
    '/bin/sh', '-c',
    `cd ${ JSON.stringify(dir) } && exec ${ CLAUDE } --dangerously-skip-permissions${ resume }`,
  ];
}
