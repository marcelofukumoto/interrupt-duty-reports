<script setup lang="ts">
// The two credentials a report needs, managed the way Extension Studio manages its GitHub token.
//
// Stored once rather than typed per run, and stored write-only: a credential goes into a Secret
// and never comes back out to this page. What the page can know is whether one is there, which
// is what decides between "Set" and "Replace" - so a field says "leave blank to keep" instead of
// showing a value somebody could shoulder-read.
//
// The GitHub token is shared with Extension Studio on purpose. It is the same credential - an
// account's token, reused by everything publishing on their behalf - so if that extension
// already has one this borrows it rather than asking for a second copy to keep in step.
import { computed, ref } from 'vue';
import { Banner } from '@components/Banner';
import { saveCredentials } from '../lib/credentials';
import type { CredentialStatus } from '../lib/credentials';

const props = defineProps<{
  status: CredentialStatus;
  /** Whose credentials these are. Stored per person, so this is about yours and nobody else's. */
  principalId: string;
  /** True when this opened because a run could not start without them. */
  blocking?: boolean;
  busy?: boolean;
}>();

const emit = defineEmits<{
  (e: 'cancel'): void;
  (e: 'saved'): void;
}>();

const jira = ref('');
const github = ref('');
const showJira = ref(false);
const showGithub = ref(false);
const saving = ref(false);
const error = ref('');

const ghStored = computed(() => props.status.gh);

/** Nothing typed and nothing missing means there is nothing to do but carry on. */
const ready = computed(() => (ghStored.value || !!github.value.trim()) && (props.status.jira || !!jira.value.trim()));

async function save() {
  if (!ready.value || saving.value) {
    return;
  }

  saving.value = true;
  error.value = '';

  try {
    await saveCredentials(props.principalId, {
      ...(github.value.trim() ? { ghToken: github.value.trim() } : {}),
      ...(jira.value.trim() ? { jiraPat: jira.value.trim() } : {}),
    });
    jira.value = '';
    github.value = '';
    emit('saved');
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    saving.value = false;
  }
}

async function clear(which: 'gh' | 'jira') {
  saving.value = true;
  error.value = '';

  try {
    await saveCredentials(props.principalId, which === 'gh' ? { ghToken: '' } : { jiraPat: '' });
    emit('saved');
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="creds-backdrop" @click.self="!saving && !busy && emit('cancel')">
    <div
      class="creds"
      role="dialog"
      aria-modal="true"
      aria-labelledby="idr-creds-title"
      data-testid="idr-credentials"
    >
      <h2 id="idr-creds-title" class="creds__title">
        Credentials
      </h2>

      <p class="creds__lede">
        <template v-if="blocking">
          A report reads the three active Jira queues and the last 30 days of
          <code>rancher/dashboard</code> community issues as <em>you</em>, so it needs your own
          token for each. They are stored once — you will not be asked again.
        </template>
        <template v-else>
          Yours, not the installation's: a report is fetched with your access. Stored in a Secret
          and read by the agent pod when a report runs — they never come back out to this page, so
          a stored one can be replaced but not shown.
        </template>
      </p>

      <Banner v-if="error" color="error">
        {{ error }}
      </Banner>

      <label class="creds__field">
        <span class="creds__label">
          Jira personal access token
          <span class="creds__state" :class="{ 'is-set': status.jira }">{{ status.jira ? 'Stored' : 'Not set' }}</span>
        </span>
        <span class="creds__hint">
          jira.suse.com → Profile → Personal Access Tokens.
          <template v-if="status.jira"> Leave blank to keep the stored one.</template>
        </span>
        <span class="creds__input">
          <input
            v-model="jira"
            :type="showJira ? 'text' : 'password'"
            autocomplete="off"
            spellcheck="false"
            data-testid="idr-jira-pat"
            :placeholder="status.jira ? '••••••••  (stored)' : 'JIRA_PAT'"
            @keyup.enter="save"
          >
          <button type="button" class="creds__peek" :title="showJira ? 'Hide' : 'Show'" @click="showJira = !showJira">
            <i class="icon" :class="showJira ? 'icon-hide' : 'icon-show'" />
          </button>
        </span>
        <button v-if="status.jira" type="button" class="creds__clear" :disabled="saving" @click="clear('jira')">
          Remove the stored token
        </button>
      </label>

      <label class="creds__field">
        <span class="creds__label">
          GitHub token
          <span class="creds__state" :class="{ 'is-set': ghStored }">
            {{ ghStored ? 'Stored' : 'Not set' }}
          </span>
        </span>
        <span class="creds__hint">
          Read-only, public access is all it needs: a classic token with the
          <code>public_repo</code> scope, or a fine-grained token with
          <em>Public repositories (read-only)</em>. It never writes.
          <template v-if="ghStored"> Leave blank to keep the stored one.</template>
        </span>
        <span class="creds__input">
          <input
            v-model="github"
            :type="showGithub ? 'text' : 'password'"
            autocomplete="off"
            spellcheck="false"
            data-testid="idr-gh-token"
            :placeholder="ghStored ? '••••••••  (stored)' : 'GH_TOKEN'"
            @keyup.enter="save"
          >
          <button type="button" class="creds__peek" :title="showGithub ? 'Hide' : 'Show'" @click="showGithub = !showGithub">
            <i class="icon" :class="showGithub ? 'icon-hide' : 'icon-show'" />
          </button>
        </span>
        <button v-if="ghStored" type="button" class="creds__clear" :disabled="saving" @click="clear('gh')">
          Remove the stored token
        </button>
      </label>

      <Banner color="info" class="creds__note">
        Written straight into the Secret under keys of your own and never read back by this page
        — replacing one is possible, seeing it is not. Saving touches your keys alone, so nobody
        else's tokens are read or rewritten. The agent pod reads them with its own ServiceAccount
        at the moment a report runs.
      </Banner>

      <div class="creds__actions">
        <button type="button" class="btn role-secondary" :disabled="saving || busy" @click="emit('cancel')">
          {{ blocking ? 'Cancel' : 'Close' }}
        </button>
        <button
          type="button"
          class="btn role-primary"
          :disabled="!ready || saving || busy"
          data-testid="idr-run-confirm"
          @click="save"
        >
          {{ saving ? 'Saving…' : busy ? 'Starting…' : blocking ? 'Save and generate' : 'Save' }}
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
  max-width: 580px;
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
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 600;
    font-size: 13px;
    margin-bottom: 2px;
  }

  &__state {
    padding: 1px 8px;
    border-radius: 10px;
    border: 1px solid var(--border);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);

    &.is-set {
      color: var(--success);
      border-color: var(--success);
    }
  }

  &__hint {
    display: block;
    color: var(--muted);
    font-size: 12px;
    line-height: 17px;
    margin-bottom: 6px;

    em {
      font-style: normal;
      color: var(--body-text);
    }
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

  &__clear {
    margin-top: 6px;
    border: none;
    background: transparent;
    padding: 0;
    color: var(--error);
    font-size: 11px;
    cursor: pointer;

    &:hover {
      text-decoration: underline;
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
