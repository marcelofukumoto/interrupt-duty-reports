# interrupt-duty-reports-console

The Rancher UI team's **daily interrupt-duty report**, as a Rancher UI extension.

One page, one button. It asks the agent already running in the cluster for today's report,
stores the result in the cluster, and shows it as something you can read and act on — every
Jira ticket and community issue with a class, a recommended next step, and a comment you can
copy and send.

## What it does

- **Generate** — starts a conversation in the cluster's agent pod. The agent gathers the day's
  data, analyses it against the report specification, and publishes the result. While it runs,
  the row shows which of the four steps it is on — read from the files the run has produced, not
  guessed from the terminal.
- **Watch the agent** — opens the run's conversation as a live terminal, in the same Rancher
  drawer the report opens in. It stays openable for 30 minutes after a run finishes, which is
  when the transcript is most worth reading — the agent explains the judgment calls the report
  itself does not carry.
- **Stop** — ends the run in flight.
- **Delete** — on each row in the list view, and inside the report in both views. A calendar
  square is a hundred pixels wide with no room for a button and its confirmation, so there the
  way to it is to open the report; a list row has the room, and deleting a run that failed is
  pure housekeeping — there is nothing in it to read, so making somebody open it first would be
  a detour through a page that exists to say "there is nothing here".

Reports are kept as ConfigMaps, so they survive a pod restart, a Rancher restart and a
reinstall of this extension. The newest **100** are retained; publishing the 101st removes the
oldest.

### Two views

A toggle beside the search box switches between them, and the choice is remembered in
`localStorage` for next time. The **calendar** is the default.

| View | What it is for |
| --- | --- |
| **Calendar** | The shape of the month — which days had a report, which were quiet, which were missed. |
| **List** | The reports in the order they were written, grouped by Today / Yesterday / This week / Earlier. |

Search behaves differently in each, on purpose: the list **filters** to the matching reports,
while the calendar **dims** the days it did not match — a day that had a report still had one,
and removing it would make the month look emptier than it was.

### The calendar

Reports are laid out on the month they were written for, because a report is a daily thing and
the question a list cannot answer is the one people have: *did we do this every day*. A row
that is missing looks exactly like a row nobody scrolled to; an empty square is a gap you can
see.

Each square carries the number that matters — how many items were owed a move that day — and is
tinted from it, a five-step sequential scale across the grid. The number is printed as well as
encoded, so the colour is the second way of reading a square and never the only one. Weekends
are drawn recessively, days from the neighbouring month faintly, and a run that failed shows as
itself rather than as an absence.

Above both views sits a stat tile: what is owed today, the change since the previous report,
and the trend across the last dozen. It has no hover layer — every day's count is already
printed in its own square below, so a tile that changed what it said as the pointer crossed it
would have been motion in exchange for nothing.

### Reading a report

Clicking a day opens it in a wide slide-in, where two things do most of the work:

- **Filter by class.** On a busy day a report is thirty items and you almost always want one
  subset of them — usually *Act now*. The chips filter every section at once, the section
  counts follow, and the copy button copies what you are looking at rather than the lot.
- **What changed since the last report.** A ticket appearing for the first time is a new
  obligation; one appearing for the fourth day running is the queue not moving. The previous
  report is compared against this one, the header says how many are new, carried over and
  cleared, and the new ones are badged. It costs one extra ConfigMap read and nothing from the
  agent — the report format is unchanged.

**Nothing in the panel is pinned.** A header that shrinks as you scroll has to be measured by
anything scrolling to a position beneath it, and a measurement that changes is a measurement
that goes wrong — it put section titles behind the header twice before the idea was abandoned.
The panel is also opened without a `title`, because setting one makes Rancher's
`SlideInPanelManager` draw its own header bar, which does not scroll either; the panel carries
its own heading and close button instead, and Escape and the backdrop close it as always.

A run that failed or was stopped opens too — in both views — showing why and offering to delete
itself, rather than being a row or a square that does nothing when clicked.

## Requirements

### The Agents extension

All AI in this extension runs through [codyrancher/agents][agents]. That extension owns the one
claude pod in the cluster, the login inside it, and the conversations; this one starts a
conversation there and reads the result back out of the cluster. It has no model, no API key
and no agent of its own.

Install Agents first. The reports page says so plainly if it is missing, too old, or its pod
has not come up yet — the Generate button stays disabled until all three are true.

[agents]: https://github.com/codyrancher/agents

### Two tokens, stored once

The report reads Jira and `rancher/dashboard`, so it needs a credential for each. They are
stored the way Extension Studio stores its GitHub token — copied from that extension down to the
key name, because the interesting part is not where the Secret is but how it is handled.

| Token | What it is | What it needs |
| --- | --- | --- |
| `jira_pat` | A Jira personal access token from `jira.suse.com` → Profile → **Personal Access Tokens** | Read access to the `SURE` project |
| `gh_token` | A GitHub token | **Classic:** the `public_repo` scope. **Fine-grained:** *Public repositories (read-only)* |

**Read-only public access is all GitHub needs.** `rancher/dashboard` is public, and the daily
report deliberately does not touch Dependabot alerts — those are a separate process, and reading
them would need `security_events` plus repo-admin rights on a repository nobody here owns. The
gather makes exactly one GitHub call: a read-only GraphQL query for the repository's open
issues. Nothing is ever written.

**The GitHub token is shared with Extension Studio.** If that extension has one, this borrows
it: the same key, in the same kind of Secret, because it is the same credential — an account's
token, reused by everything publishing on their behalf. Asking for a second copy would be asking
somebody to keep two copies of one secret in step. Setting one here overrides it; the dialog
says which is in use.

#### How they are handled

Four properties, all of them inherited from Extension Studio's design:

- **Write-only from the browser.** A credential goes into the Secret and never comes back out.
  Nothing in this extension fetches a Secret's `data`.
- **`PartialObjectMetadata`.** Asking the apiserver for that representation returns `metadata`
  with no `data` and no `stringData` — the only way to learn anything about a Secret from a
  browser without the browser receiving it. It goes on the writes as much as the read, because a
  PATCH answers with the whole updated object by default, which is the same leak in reverse. It
  has to be the raw `/api/v1/...` path; Steve answers in its own shape and ignores the header.
- **Merge patches.** A read-modify-PUT would have to fetch the object to preserve the keys it is
  not touching, pulling the credential into the page on every save. A patch says what changed;
  `null` deletes a key.
- **An annotation says whether one is stored**, so the dialog can choose between "Set" and
  "Replace" without going near `data`.

The agent pod reads them itself, with its own ServiceAccount, at the moment a report runs — see
`seed/run.sh`. Nothing is sent from the browser into the pod, which is what the run used to do.

## How a run works

```
 browser                        agent pod (extension-studio)          cluster
 ───────                        ────────────────────────────          ───────
 Generate ──────── summary ConfigMap: status "running" ──────────────────► │
          ── writes gather.mjs, run.sh, publish.sh, the spec ──► /workspace/.interrupt-duty
          ── startInProject(prompt) + start the pane ────────► conversation
                                        │
                                        ├─ run.sh      → reads the Secret, then data.json
                                        ├─ the spec    → report.json
                                        └─ publish.sh  ── payload + summary ConfigMaps ──► │
 list polls the summary ◄─────────────────────────────────────────────────────────────────┘
```

Everything deterministic is a script; everything judged is the prompt. The agent's job starts
at `data.json` and stops at `report.json` — neither end of it is left to the agent to
improvise, and `publish.sh` refuses to publish a `report.json` that is not a valid report.

### Watching the agent

There is one drawer, so opening the session replaces the report in it. That made closing a dead
end — it put you back on the calendar rather than where you came from — so the session opened
from a report carries a **Back to the report** action beside its Close. A session opened from
the strip of a run still in flight does not: there is no report yet to go back to.

The pane is the Agents extension's own terminal component, placed in a drawer of this
extension's — the pattern `dev-extension` uses to put a conversation under a pull-request
comment, and the one thing that extension publishes for others to borrow. Nothing here owns a
terminal: not the socket protocol, not the reconnect, not the image paste or the clickable
paths. There is one terminal in this dashboard and one place it is fixed.

Two details in `AgentTerminal.vue` are less obvious than they look, and both come from that
precedent. The API is **awaited**, not read once — extensions load in whatever order Rancher
loaded them, so reading at mount reports "not installed" for one that is merely slower. And the
pane's container must be a flex column with **`min-height: 0`** all the way down, or the
terminal grows the page instead of sizing itself to the drawer.

What this deliberately does *not* do is drive the Agents extension's own drawer. That was tried:
it meant reaching for state and a keystroke that extension never published, and it put this
extension's conversations in a tab strip meant for its own. Runs are **project** conversations
(`p-interrupt-duty-<n>`), which its drawer excludes by design, and they are shown here instead.

Conversations are swept 30 minutes after their run ends, rather than the instant it ends. The
window is a **time**, not "is somebody looking at it", because looking at it is per-tab: another
open tab of this page runs its own loop, knows nothing about this one's open drawer, and would
end the session out from under it.

## The report specification

[`pkg/interrupt-duty-reports-console/seed/daily-report.prompt.md`](pkg/interrupt-duty-reports-console/seed/daily-report.prompt.md)
is the single source of truth for what a report *is*: the four classes, the "who has the ball"
rules, the readiness gate for opening a GitHub issue, the next-step verbs, the suggested
comments, and the exact JSON shape. It is the team's existing daily-report prompt with its
output section rewritten from markdown to JSON, so that the UI has something to render
structurally instead of a wall of text.

Changing what a report contains means changing that file. Nothing about the report's content
is decided in a Vue component.

## Storage layout

Two ConfigMaps per report, in the `interrupt-duty-reports-console` namespace:

| Name | Label `interrupt-duty.rancher.io/report` | Holds |
| --- | --- | --- |
| `daily-<date>-<time>` | `summary` | `meta.json` — status, counts, headline, Top 3 refs |
| `daily-<date>-<time>-report` | `payload` | `report.json` — the report itself |

The split is why the list is cheap: drawing a hundred rows fetches a hundred summaries, not a
hundred reports. The payload is fetched only when a report is opened.

## Development

```sh
nvm use                 # node 24
yarn install
yarn gen-seed           # after editing anything under pkg/*/seed or pkg/*/assets
yarn lint
yarn type-check
yarn build-pkg interrupt-duty-reports-console
```

`seed.generated.ts` and `icon.generated.ts` are committed, so a normal build never runs
`gen-seed` — but the in-pod scripts are written into the pod from the generated file on **every
run**, so an edit under `seed/` that has not been regenerated is an edit that never reaches the
pod. CI regenerates both and fails on a diff.

### The icons

Two, for two different renderers:

| File | Where it is used | Constraint |
| --- | --- | --- |
| `assets/nav-icon.svg` | the sidebar | **One colour.** Rancher renders a product's icon through an `<img>` and recolours it with a generated CSS filter (shell's `IconOrSvg`), which assumes a single colour to filter from — a two-colour glyph comes out mangled. It is inlined into the bundle as a data URI, because a built extension is served from a path chosen by whoever installed it, so an emitted asset's URL is not something the build gets to know. |
| `assets/icon.svg` | the Extensions catalog card | Shown as-is, so it keeps its colours. Published to the root of `gh-pages` and named by `package.json`'s `icon`. |

Both draw the same mark — a report with an alert on it — so the two read as one thing.

## Installing

In Rancher, go to **Apps → Repositories**, add an `http(s)` repository pointing at

```
https://marcelofukumoto.github.io/interrupt-duty-reports-console/
```

then open **Extensions** and install **Interrupt Duty Reports**. Install
[Agents][agents] the same way if it is not there yet.

## Publishing

Pushing a change to `pkg/interrupt-duty-reports-console/package.json`'s `version` on `main` builds the
extension and publishes it to the `gh-pages` branch as a Helm repository, using
`rancher/dashboard`'s own reusable workflow. The version is the whole of publishing — a chart
version is meant to be immutable, so a push that does not change it republishes nothing.
