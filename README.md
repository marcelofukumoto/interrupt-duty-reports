# interrupt-duty-reports

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
- **Stop** — ends the run in flight.
- **Delete** — removes one report.

Reports are kept as ConfigMaps, so they survive a pod restart, a Rancher restart and a
reinstall of this extension. The newest **100** are retained; publishing the 101st removes the
oldest.

### Reading a report

The report opens in a wide slide-in, and three things there do most of the work:

- **Filter by class.** On a busy day a report is thirty items and you almost always want one
  subset of them — usually *Act now*. The chips filter every section at once, the section
  counts follow, and the copy button copies what you are looking at rather than the lot.
- **What changed since the last report.** A ticket appearing for the first time is a new
  obligation; one appearing for the fourth day running is the queue not moving. The previous
  report is compared against this one, the header says how many are new, carried over and
  cleared, and the new ones are badged. It costs one extra ConfigMap read and nothing from the
  agent — the report format is unchanged.
- **A header that stays.** The date, the filters and the section jumps stay put while the body
  scrolls, shrinking once you are past the top so they cost a strip rather than a third of the
  panel.

The list itself groups by day, is searchable by date, ticket reference or summary (`/` focuses
the box), and leads with a stat tile: how many items are owed a move today, the change since
the previous report, and the trend across the last dozen.

## Requirements

### The Agents extension

All AI in this extension runs through [codyrancher/agents][agents]. That extension owns the one
claude pod in the cluster, the login inside it, and the conversations; this one starts a
conversation there and reads the result back out of the cluster. It has no model, no API key
and no agent of its own.

Install Agents first. The reports page says so plainly if it is missing, too old, or its pod
has not come up yet — the Generate button stays disabled until all three are true.

[agents]: https://github.com/codyrancher/agents

### Two tokens, per run

The report reads Jira and GitHub, so it needs a credential for each. They are typed into the
dialog when you press Generate.

| Token | What it is | What it needs |
| --- | --- | --- |
| `JIRA_PAT` | A Jira personal access token from `jira.suse.com` → Profile → **Personal Access Tokens** | Read access to the `SURE` project |
| `GH_TOKEN` | A GitHub token | **Classic:** the `public_repo` scope. **Fine-grained:** *Public repositories (read-only)* |

**Read-only public access is all it needs.** `rancher/dashboard` is a public repository, and
the daily report deliberately does not touch Dependabot alerts — those are a separate process,
and reading them would need `security_events` plus repo-admin rights on a repository nobody
here owns.

The gather makes exactly one GitHub call: a read-only GraphQL query for the repository's open
issues. Nothing is ever written — no issue is opened, commented on or labelled by this
extension, and the suggested comments are for you to paste yourself.

> A fine-grained token cannot be scoped to `rancher/dashboard` specifically unless that
> organization has opted your account in, so *Public repositories (read-only)* is the
> fine-grained equivalent.

#### Why they are not stored

Every user of this extension is a Rancher admin. A Kubernetes Secret readable by every admin
protects a personal Jira token from nobody — it just turns it into a shared credential with
your name on it. So instead:

- they are held in the browser tab's memory for as long as the tab is open, so a second report
  in one sitting is one click;
- they are written into the agent pod as a `0600` file owned by the pane's user, over the exec
  socket's **stdin** — never on a command line, where every process in the pod could read them,
  and never in the prompt, which ends up in a transcript;
- the gather reads the file once, and `publish.sh` deletes it when the run ends — as does Stop,
  and as does a run that fails before it starts;
- nothing is written to `localStorage`, and nothing survives a refresh.

## How a run works

```
 browser                        agent pod (extension-studio)          cluster
 ───────                        ────────────────────────────          ───────
 Generate ──────── summary ConfigMap: status "running" ──────────────────► │
          ── writes gather.mjs, run.sh, publish.sh, the spec ──► /workspace/.interrupt-duty
          ── writes creds.json (0600, stdin only) ────────────► <run dir>
          ── startInProject(prompt) + start the pane ────────► conversation
                                        │
                                        ├─ run.sh      → data.json
                                        ├─ the spec    → report.json
                                        └─ publish.sh  ── payload + summary ConfigMaps ──► │
 list polls the summary ◄─────────────────────────────────────────────────────────────────┘
```

Everything deterministic is a script; everything judged is the prompt. The agent's job starts
at `data.json` and stops at `report.json` — neither end of it is left to the agent to
improvise, and `publish.sh` refuses to publish a `report.json` that is not a valid report.

## The report specification

[`pkg/interrupt-duty-reports/seed/daily-report.prompt.md`](pkg/interrupt-duty-reports/seed/daily-report.prompt.md)
is the single source of truth for what a report *is*: the four classes, the "who has the ball"
rules, the readiness gate for opening a GitHub issue, the next-step verbs, the suggested
comments, and the exact JSON shape. It is the team's existing daily-report prompt with its
output section rewritten from markdown to JSON, so that the UI has something to render
structurally instead of a wall of text.

Changing what a report contains means changing that file. Nothing about the report's content
is decided in a Vue component.

## Storage layout

Two ConfigMaps per report, in the `interrupt-duty-reports` namespace:

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
yarn build-pkg interrupt-duty-reports
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
https://marcelofukumoto.github.io/interrupt-duty-reports/
```

then open **Extensions** and install **Interrupt Duty Reports**. Install
[Agents][agents] the same way if it is not there yet.

## Publishing

Pushing a change to `pkg/interrupt-duty-reports/package.json`'s `version` on `main` builds the
extension and publishes it to the `gh-pages` branch as a Helm repository, using
`rancher/dashboard`'s own reusable workflow. The version is the whole of publishing — a chart
version is meant to be immutable, so a push that does not change it republishes nothing.
