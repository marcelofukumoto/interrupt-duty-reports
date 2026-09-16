// The agents extension, as this one reaches it.
//
// All the AI in this extension runs through codyrancher/agents: it owns the one claude pod in
// the cluster, the login inside it, and the conversations. This extension starts a conversation
// there and reads the result out of the cluster - it has no model, no key and no agent of its
// own, which is the point.
//
// The bridge is `window.__agents`, which that extension installs on every page (see its
// public-api.ts). Nothing is imported from it: two extensions are two bundles, and `window` is
// the one thing they share.

/** What the agents extension offers. Structural, because it is reached through `window`. */
export interface AgentsApi {
  version: string;
  terminal: { component: unknown };
  agent: {
    namespace: string;
    container: string;
    pod(): Promise<string | null>;
    command(id: string, mode?: 'claude' | 'shell'): string[];
    sessions(): Promise<{ id: string; title: string }[]>;
    projectSessions(project: string): Promise<{ id: string; title: string }[]>;
    start(): Promise<string>;
    startInProject(project: string, title?: string, prompt?: string): Promise<string>;
    queue(id: string, prompt: string): Promise<void>;
    rename(id: string, title: string): Promise<void>;
    end(id: string): Promise<void>;
    pane(id: string, lines?: number): Promise<{ text: string; running: boolean }>;
  };
}

const AGENTS_GLOBAL = '__agents';
const AGENTS_READY_EVENT = 'agents:ready';

/**
 * Where the agents extension keeps its drawer, and how to point it at one conversation.
 *
 * Both of these are that extension's own names rather than anything it publishes, and using them
 * is a deliberate trade. Its public API offers the terminal as a component to mount, which is
 * the supported way to show a conversation - but a pane mounted here is a second place agent
 * conversations live, and the whole point of this is to have one. So the drawer is opened
 * instead, and every reach below is guarded: the worst case is the drawer opens without the
 * right tab selected, which is a tab somebody picks by name.
 */
const DRAWER_HOST_ID = 'extension-studio-agent-overlay';
const DRAWER_STATE_KEY = 'extension-studio.agent.drawer';

/** The physical key of the chord that opens the drawer - see the agents extension's overlay.ts. */
const DRAWER_CHORD_CODE = 'Backquote';

/**
 * The version that first offered what this extension calls: `startInProject` with an opening
 * prompt, and `pane` to read a conversation back. An older agents is a working drawer and a
 * broken report, which is a thing to say up front rather than a call that fails halfway
 * through a run.
 */
export const MIN_AGENTS_VERSION = '0.1.40';

export function agentsApi(): AgentsApi | null {
  return (window as unknown as Record<string, AgentsApi | undefined>)[AGENTS_GLOBAL] || null;
}

/**
 * Ask the drawer to come back on this conversation.
 *
 * `active` only - never `open`. The panel opens itself on mount when the stored state says open,
 * and the chord below then toggles it straight back shut; writing the one field the tab is
 * chosen from and leaving the rest avoids that, and leaves somebody's docking side and panel
 * size alone into the bargain.
 */
function rememberDrawerTab(session: string): void {
  try {
    const stored = JSON.parse(window.localStorage.getItem(DRAWER_STATE_KEY) || '{}') || {};

    window.localStorage.setItem(DRAWER_STATE_KEY, JSON.stringify({ ...stored, active: session }));
  } catch {
    // A browser that will not store it is one where the drawer opens on its own last tab.
  }
}

function drawerIsOpen(): boolean {
  try {
    return JSON.parse(window.localStorage.getItem(DRAWER_STATE_KEY) || '{}')?.open === true;
  } catch {
    return false;
  }
}

/** What opening the drawer managed to do, so a caller can say something useful about the rest. */
export type DrawerResult = 'selected' | 'opened' | 'already-open';

/**
 * Open the agents drawer on one conversation.
 *
 * Through the two things that extension actually offers a stranger: the state it keeps in
 * localStorage, and the chord it listens for. Its panel is a Vue app of its own mounted on the
 * body, and reaching into that for a method to call is the kind of coupling that breaks on
 * somebody else's release - so this does not.
 *
 * What that costs is honest and bounded. A drawer being built for the first time reads the
 * stored tab and lands on it, which is the common case. One that has already chosen a tab once
 * prefers its own from then on, so re-pointing it is not possible from out here and the caller
 * says which tab to click instead. Every conversation this extension starts is named for its
 * date, so that instruction is followable.
 */
export function openAgentDrawer(session: string): DrawerResult {
  rememberDrawerTab(session);

  if (drawerIsOpen()) {
    return 'already-open';
  }

  // A panel that does not exist yet is built by this and restores the tab just written; one that
  // exists already will open on whichever tab it last had.
  const fresh = !document.getElementById(DRAWER_HOST_ID);

  window.dispatchEvent(new KeyboardEvent('keydown', {
    code: DRAWER_CHORD_CODE, ctrlKey: true, shiftKey: true, bubbles: true,
  }));

  return fresh ? 'selected' : 'opened';
}

/** Compare two dotted versions numerically - `0.1.9` is not later than `0.1.40`. */
function atLeast(version: string, minimum: string): boolean {
  const left = String(version || '').split('.').map((p) => parseInt(p, 10) || 0);
  const right = minimum.split('.').map((p) => parseInt(p, 10) || 0);

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const a = left[i] || 0;
    const b = right[i] || 0;

    if (a !== b) {
      return a > b;
    }
  }

  return true;
}

export type AgentsState = 'ready' | 'missing' | 'outdated' | 'no-pod' | 'checking';

export interface AgentsStatus {
  state: AgentsState;
  version: string | null;
  pod: string | null;
  /** One sentence for the banner: what is wrong and what to do about it. */
  detail: string;
}

/**
 * Whether a report can actually be generated right now.
 *
 * Three separate things can be missing and they need three different sentences, because the fix
 * is different for each: the extension is not installed, it is too old, or it is installed and
 * its pod has not come up yet (which is normal for the first minute or two after a restart -
 * the pod installs tmux and the claude CLI on boot).
 */
export async function agentsStatus(): Promise<AgentsStatus> {
  const api = agentsApi();

  if (!api) {
    return {
      state:   'missing',
      version: null,
      pod:     null,
      detail:  'The Agents extension is not installed in this Rancher. Install codyrancher/agents — this extension runs every report through the agent pod it provides.',
    };
  }

  if (!atLeast(api.version, MIN_AGENTS_VERSION)) {
    return {
      state:   'outdated',
      version: api.version,
      pod:     null,
      detail:  `The Agents extension is ${ api.version }; this needs ${ MIN_AGENTS_VERSION } or later for conversations that can be started with an opening prompt.`,
    };
  }

  const pod = await api.agent.pod().catch(() => null);

  if (!pod) {
    return {
      state:   'no-pod',
      version: api.version,
      pod:     null,
      detail:  'The agent pod is not running yet. It comes up on its own — give it a minute after a Rancher restart, then refresh.',
    };
  }

  return {
    state:   'ready',
    version: api.version,
    pod,
    detail:  `Agents ${ api.version } · agent pod ${ pod }`,
  };
}

/** Resolve once the agents bundle has installed its API, for a page that loaded first. */
export function whenAgentsReady(timeoutMs = 8000): Promise<AgentsApi | null> {
  const present = agentsApi();

  if (present) {
    return Promise.resolve(present);
  }

  return new Promise((resolve) => {
    const done = (value: AgentsApi | null) => {
      window.removeEventListener(AGENTS_READY_EVENT, onReady);
      clearTimeout(timer);
      resolve(value);
    };
    const onReady = () => done(agentsApi());
    const timer = setTimeout(() => done(agentsApi()), timeoutMs);

    window.addEventListener(AGENTS_READY_EVENT, onReady);
  });
}
