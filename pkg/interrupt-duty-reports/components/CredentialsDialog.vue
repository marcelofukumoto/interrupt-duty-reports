<script setup lang="ts">
// The two tokens a report needs, asked for at the moment it is run.
//
// Deliberately not a Secret and deliberately not remembered.
//
// This extension's premise is that everybody using it is a Rancher admin, which means Rancher's
// own secret storage would protect these from nobody: a Secret readable by every admin is a
// shared credential, and a Jira PAT is a person's, not the cluster's. So they are typed per run,
// held in this tab's memory only for as long as the tab is open, written into the agent pod as
// a 0600 file that the gather reads once, and removed by publish.sh when the run ends. Nothing
// is written to localStorage, and nothing survives a refresh.
import { computed, ref } from 'vue';
import { Banner } from '@components/Banner';

const props = defineProps<{
  /** Prefilled from this tab's memory, so a second report in one sitting is one click. */
  jiraPat: string;
  ghToken: string;
  busy: boolean;
}>();

const emit = defineEmits<{
  (e: 'cancel'): void;
  (e: 'run', value: { jiraPat: string; ghToken: string }): void;
}>();

const jira = ref(props.jiraPat);
const github = ref(props.ghToken);
const showJira = ref(false);
const showGithub = ref(false);

const ready = computed(() => !!jira.value.trim() && !!github.value.trim());

function run() {
  if (!ready.value || props.busy) {
    return;
  }

  emit('run', { jiraPat: jira.value.trim(), ghToken: github.value.trim() });
}
</script>

<template>
  <div class="creds-backdrop" @click.self="!busy && emit('cancel')">
    <div
      class="creds"
      role="dialog"
      aria-modal="true"
      aria-labelledby="idr-creds-title"
      data-testid="idr-credentials"
    >
      <h2 id="idr-creds-title" class="creds__title">
        Run today's report
      </h2>

      <p class="creds__lede">
        The report reads the three active Jira queues and the last 30 days of
        <code>rancher/dashboard</code> community issues, so it needs a token for each.
      </p>

      <label class="creds__field">
        <span class="creds__label">Jira personal access token</span>
        <span class="creds__hint">jira.suse.com → Profile → Personal Access Tokens</span>
        <span class="creds__input">
          <input
            v-model="jira"
            :type="showJira ? 'text' : 'password'"
            autocomplete="off"
            spellcheck="false"
            data-testid="idr-jira-pat"
            placeholder="JIRA_PAT"
            @keyup.enter="run"
          >
          <button type="button" class="creds__peek" :title="showJira ? 'Hide' : 'Show'" @click="showJira = !showJira">
            <i class="icon" :class="showJira ? 'icon-hide' : 'icon-show'" />
          </button>
        </span>
      </label>

      <label class="creds__field">
        <span class="creds__label">GitHub token</span>
        <span class="creds__hint">
          Read-only, public access is all it needs: a classic token with the
          <code>public_repo</code> scope, or a fine-grained token with
          <em>Public repositories (read-only)</em>. It never writes — no issue is opened,
          commented on or labelled.
        </span>
        <span class="creds__input">
          <input
            v-model="github"
            :type="showGithub ? 'text' : 'password'"
            autocomplete="off"
            spellcheck="false"
            data-testid="idr-gh-token"
            placeholder="GH_TOKEN"
            @keyup.enter="run"
          >
          <button type="button" class="creds__peek" :title="showGithub ? 'Hide' : 'Show'" @click="showGithub = !showGithub">
            <i class="icon" :class="showGithub ? 'icon-hide' : 'icon-show'" />
          </button>
        </span>
      </label>

      <Banner color="info" class="creds__note">
        Both tokens go straight into the agent pod as a <code>0600</code> file, are read once by
        the gather, and are deleted when the run ends. They are never stored in a Secret, never
        put in the prompt, and never kept after you close this tab.
      </Banner>

      <div class="creds__actions">
        <button type="button" class="btn role-secondary" :disabled="busy" @click="emit('cancel')">
          Cancel
        </button>
        <button
          type="button"
          class="btn role-primary"
          :disabled="!ready || busy"
          data-testid="idr-run-confirm"
          @click="run"
        >
          {{ busy ? 'Starting…' : 'Generate report' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
// Rancher's global `code` style is built for blocks: its padding turns a token name used
// mid-sentence into a tall box that breaks the line it is on. Inline code here is a word.
:deep(code) {
  padding: 1px 5px;
  font-size: 0.92em;
  line-height: inherit;
  vertical-align: baseline;
  border-radius: 3px;
}

.creds-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.5);
}

.creds {
  width: 100%;
  max-width: 560px;
  max-height: 90vh;
  overflow-y: auto;
  padding: 24px;
  border-radius: 8px;
  background: var(--body-bg);
  border: 1px solid var(--border);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35);

  &__title {
    margin: 0 0 8px;
    font-size: 20px;
  }

  &__lede {
    margin: 0 0 20px;
    color: var(--muted);
    font-size: 13px;
    line-height: 19px;
  }

  &__field {
    display: block;
    margin-bottom: 18px;
  }

  &__label {
    display: block;
    font-weight: 600;
    font-size: 13px;
    margin-bottom: 2px;
  }

  &__hint {
    display: block;
    color: var(--muted);

    em {
      font-style: normal;
      color: var(--body-text);
    }
    font-size: 12px;
    line-height: 17px;
    margin-bottom: 6px;
  }

  &__input {
    display: flex;
    align-items: stretch;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    overflow: hidden;

    &:focus-within {
      border-color: var(--link);
    }

    input {
      flex: 1;
      min-width: 0;
      padding: 8px 10px;
      border: none;
      outline: none;
      background: transparent;
      color: var(--input-text);
      font-family: var(--font-family-mono, monospace);
      font-size: 13px;
    }
  }

  &__peek {
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    padding: 0 10px;

    &:hover {
      color: var(--body-text);
    }
  }

  &__note {
    font-size: 12px;
    line-height: 18px;
  }

  &__actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 20px;
  }
}
</style>
