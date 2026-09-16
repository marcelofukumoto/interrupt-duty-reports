<script setup lang="ts">
// The run's own terminal, live.
//
// Not a copy of one: this mounts the agents extension's own pane, so what opens here is the
// same xterm, the same exec socket, the same tmux reattach and the same chat/terminal toggle
// that its drawer uses - and it is interactive, so the conversation can be talked to rather
// than only watched.
//
// It is here rather than in that drawer because the drawer lists only `agent-<n>`: a project's
// conversations, which is what every run is, are kept out of it by design so that a workspace's
// chatter never fills the global strip. Placing the pane where it is wanted is the way the
// agents extension offers instead.
import { computed, ref } from 'vue';
import { useStore } from 'vuex';
import { Banner } from '@components/Banner';
import { terminalComponent } from '../lib/agents';
import type { ReportMeta } from '../types';

defineProps<{
  meta: ReportMeta;
  /** Declared so the slide-in's own config is consumed rather than landing on the root element. */
  width?: string;
}>();

const store = useStore();

const terminal = computed(() => terminalComponent());

/**
 * What the pane says about its socket: waiting, connecting, open, closed.
 *
 * Worth surfacing because a conversation that has ended looks, in a terminal, like a terminal
 * that printed a few lines and stopped - which reads as a broken pane rather than as a run that
 * finished while the panel was being opened.
 */
const state = ref('');

function close() {
  store.commit('slideInPanel/close');
}
</script>

<template>
  <div class="agent-session">
    <header class="agent-session__head">
      <div>
        <p class="agent-session__eyebrow">
          Agent session
        </p>
        <h2 class="agent-session__title">
          {{ meta.reportDate }}
        </h2>
        <p class="agent-session__meta">
          {{ meta.session }} · the conversation writing this report
        </p>
      </div>
      <button type="button" class="agent-session__close" aria-label="Close" title="Close" @click="close">
        <i class="icon icon-close" />
      </button>
    </header>

    <Banner v-if="!terminal" color="warning">
      The Agents extension is not available on this page, so there is no terminal to show.
    </Banner>

    <Banner v-else-if="!meta.session" color="warning">
      This run has no conversation yet — it is still being set up.
    </Banner>

    <!--
      Keyed on the session so that opening a different run's conversation builds a new pane
      rather than reusing one that is still attached to the previous session's socket.
    -->
    <div v-else class="agent-session__terminal">
      <component
        :is="terminal"
        :key="meta.session"
        :session="meta.session"
        mode="claude"
        @state="state = $event"
      />
    </div>

    <p v-if="state === 'closed'" class="agent-session__note agent-session__note--ended">
      This conversation has ended — the run it belonged to is over, and the agent pod has
      released it.
    </p>
    <p v-else class="agent-session__note">
      Closing this panel leaves the conversation running — it is the pod that holds it, not this
      page.
    </p>
  </div>
</template>

<style lang="scss" scoped>
.agent-session {
  display: flex;
  flex-direction: column;
  // The slide-in gives its content the height of the panel; the terminal is the part that grows.
  height: 100%;
  padding: 2px 4px 12px;

  &__head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }

  &__eyebrow {
    margin: 0;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
  }

  &__title {
    margin: 1px 0 3px;
    font-size: 22px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  &__meta {
    margin: 0;
    font-size: 11px;
    color: var(--muted);
    font-family: var(--font-family-mono, monospace);
  }

  &__close {
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    padding: 5px;
    border-radius: 4px;

    &:hover {
      color: var(--body-text);
      background: var(--nav-bg);
    }
  }

  &__terminal {
    flex: 1;
    min-height: 420px;
    margin-top: 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;

    // The pane sizes itself to what contains it, so what contains it has to have a size.
    > * {
      height: 100%;
    }
  }

  &__note {
    margin: 10px 0 0;
    font-size: 11px;
    color: var(--muted);

    &--ended {
      color: var(--warning);
    }
  }
}
</style>
