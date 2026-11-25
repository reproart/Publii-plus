<template>
    <div
        class="plus-inbox"
        role="dialog"
        aria-label="Content inbox">
        <header class="plus-inbox-header">
            <div class="plus-inbox-title">
                <strong>Content inbox</strong>
                <span class="plus-inbox-muted">{{ siteLabel }} · Markdown files become posts</span>
            </div>
            <div class="plus-inbox-actions">
                <p-button
                    appearance="outline"
                    :loading="busy === 'check'"
                    :disabled="!!busy || dirty"
                    :onClick="check">Check now</p-button>
                <p-button
                    :loading="busy === 'run'"
                    :disabled="!!busy || dirty"
                    :onClick="run">Import{{ form.autoSync ? ' and sync' : '' }}</p-button>
                <p-button
                    appearance="clean"
                    :onClick="() => $emit('close')">Close</p-button>
            </div>
        </header>

        <div class="plus-inbox-body">
            <section class="plus-inbox-settings">
                <h3>Source</h3>
                <div class="plus-inbox-switch">
                    <label><input
                        v-model="form.source"
                        type="radio"
                        value="github"> GitHub repository</label>
                    <label><input
                        v-model="form.source"
                        type="radio"
                        value="folder"> Local folder</label>
                </div>

                <template v-if="form.source === 'github'">
                    <label class="plus-inbox-field">Repository
                        <input
                            v-model="form.repo"
                            type="text"
                            placeholder="owner/repository or https://github.com/owner/repository"></label>
                    <div class="plus-inbox-row">
                        <label class="plus-inbox-field">Branch
                            <input
                                v-model="form.branch"
                                type="text"
                                placeholder="main"></label>
                        <label class="plus-inbox-field">Folder
                            <input
                                v-model="form.folder"
                                type="text"
                                placeholder="posts (empty = whole repository)"></label>
                    </div>
                    <label class="plus-inbox-field">Access token
                        <input
                            v-model="token"
                            type="password"
                            :placeholder="hasToken ? 'Saved – type to replace, clear to remove' : 'Only for private repositories (read-only, Contents)'"
                            autocomplete="off"
                            @input="tokenTouched = true"></label>
                </template>

                <template v-else>
                    <div class="plus-inbox-row plus-inbox-align-end">
                        <label class="plus-inbox-field">Folder
                            <input
                                v-model="form.dir"
                                type="text"
                                placeholder="/Users/me/site-posts"></label>
                        <p-button
                            appearance="outline"
                            :onClick="chooseFolder">Choose…</p-button>
                    </div>
                    <p class="plus-inbox-muted">For example a git checkout that is updated with "git pull" on this computer.</p>
                </template>

                <h3>Import</h3>
                <label class="plus-inbox-field">New posts
                    <select v-model="form.defaultStatus">
                        <option value="published">Published right away</option>
                        <option value="draft">Drafts (for review)</option>
                    </select></label>
                <label class="plus-inbox-check"><input
                    v-model="form.autoSync"
                    type="checkbox"> Render and sync the website after an import</label>
                <p
                    v-if="form.autoSync && status && status.canPublish"
                    class="plus-inbox-warning">Automatic sync is not possible: {{ status.canPublish }}.</p>
                <label class="plus-inbox-field">When a file is removed from the inbox
                    <select v-model="form.onDelete">
                        <option value="keep">Keep the post</option>
                        <option value="draft">Turn the post into a draft</option>
                    </select></label>
                <label class="plus-inbox-check"><input
                    v-model="form.overwriteLocalEdits"
                    type="checkbox"> Overwrite posts edited in Publii after their import</label>

                <h3>Schedule</h3>
                <label class="plus-inbox-check"><input
                    v-model="form.enabled"
                    type="checkbox"> Check automatically while Publii Plus is open</label>
                <label
                    v-if="form.enabled"
                    class="plus-inbox-field">Every (minutes)
                    <input
                        v-model.number="form.intervalMinutes"
                        type="number"
                        min="5"
                        max="1440"></label>

                <div class="plus-inbox-actions">
                    <p-button
                        :disabled="!dirty"
                        :loading="busy === 'save'"
                        :onClick="save">Save settings</p-button>
                    <span
                        v-if="dirty"
                        class="plus-inbox-muted">Unsaved changes</span>
                </div>

                <details class="plus-inbox-help">
                    <summary>File format</summary>
                    <pre>---
title: The healthcare paradox
date: 2026-11-25 09:00
tags: [Medicine, Research]
description: Meta description
image: images/cover.jpg
image_alt: Doctor and patient
status: published        # or draft
featured: false
slug: healthcare-paradox # optional
---
Text in **Markdown**. Images: ![Chart](images/chart.png)</pre>
                    <p class="plus-inbox-muted">Without a title the first "# Heading" or the file name is used. README.md and files in
                        folders starting with "_" are ignored. Each file stays linked to its post: changes in the file update the post.</p>
                </details>
            </section>

            <section class="plus-inbox-results">
                <template v-if="preview">
                    <h3>Next import</h3>
                    <p
                        v-if="!previewItems.length"
                        class="plus-inbox-muted">Nothing new – {{ unchangedCount }} file(s) already imported and unchanged.</p>
                    <table
                        v-else
                        class="plus-inbox-table">
                        <tr
                            v-for="item in previewItems"
                            :key="item.path">
                            <td><span :class="'plus-inbox-badge is-' + item.action">{{ actionLabel(item.action) }}</span></td>
                            <td class="plus-inbox-path">{{ item.path }}</td>
                            <td class="plus-inbox-muted">{{ item.reason }}</td>
                        </tr>
                    </table>
                </template>

                <div
                    v-if="error"
                    class="msg msg-small msg-alert">{{ error }}</div>

                <h3>History</h3>
                <p
                    v-if="!status || !status.log.length"
                    class="plus-inbox-muted">No imports yet.</p>
                <div
                    v-for="(entry, i) in (status ? status.log : [])"
                    :key="entry.at + '-' + i"
                    class="plus-inbox-entry">
                    <div class="plus-inbox-entry-head">
                        <strong>{{ new Date(entry.at).toLocaleString() }}</strong>
                        <span class="plus-inbox-muted">{{ triggerLabel(entry.trigger) }}</span>
                        <span>{{ entrySummary(entry) }}</span>
                    </div>
                    <div
                        v-if="entry.error || entry.syncError"
                        class="plus-inbox-warning">{{ entry.error || ('Sync: ' + entry.syncError) }}</div>
                    <ul
                        v-if="entry.items.length"
                        class="plus-inbox-items">
                        <li
                            v-for="item in entry.items"
                            :key="item.path">
                            <span :class="'plus-inbox-badge is-' + item.action">{{ actionLabel(item.action) }}</span>
                            {{ item.title || item.path }}
                            <span
                                v-if="item.reason"
                                class="plus-inbox-muted">– {{ item.reason }}</span>
                        </li>
                    </ul>
                </div>
            </section>
        </div>
    </div>
</template>

<script>
const EXT = 'content-inbox';

function clean (error) {
    return String(error && error.message ? error.message : error).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
}

const FIELDS = ['enabled', 'source', 'repo', 'branch', 'folder', 'dir', 'defaultStatus', 'autoSync', 'intervalMinutes', 'onDelete', 'overwriteLocalEdits'];

export default {
    name: 'plus-content-inbox',
    data () {
        return {
            status: null,
            form: {},
            saved: '',
            token: '',
            tokenTouched: false,
            hasToken: false,
            preview: null,
            busy: '',
            error: '',
            poll: null
        };
    },
    computed: {
        site () {
            const s = this.$store.state.currentSite;
            return s && s.config ? s.config.name : '';
        },
        siteLabel () {
            const s = this.$store.state.currentSite;
            return s && s.config ? (s.config.displayName || s.config.name) : '';
        },
        dirty () {
            return this.tokenTouched || JSON.stringify(this.pick(this.form)) !== this.saved;
        },
        previewItems () {
            return this.preview ? this.preview.items.filter(i => i.action !== 'unchanged') : [];
        },
        unchangedCount () {
            return this.preview ? this.preview.items.filter(i => i.action === 'unchanged').length : 0;
        }
    },
    async mounted () {
        await this.load(true);
        // a scheduled run may happen while the window is open
        this.poll = setInterval(() => this.load(false), 15000);
    },
    beforeDestroy () {
        clearInterval(this.poll);
    },
    methods: {
        call (method, ...args) {
            return this.$plus.invoke(EXT, method, ...args).catch(e => { throw new Error(clean(e)); });
        },
        pick (form) {
            const out = {};

            for (const key of FIELDS) out[key] = form[key];
            return out;
        },
        async load (resetForm) {
            try {
                const previous = this.status ? this.status.revision : null;
                const status = await this.call('status', this.site);
                this.status = status;
                this.hasToken = status.hasToken;

                if (resetForm) {
                    this.form = { ...status.config };
                    this.saved = JSON.stringify(this.pick(this.form));
                }

                if (previous !== null && previous !== status.revision) this.refreshPosts();
            } catch (e) {
                this.error = e.message;
            }
        },
        async save () {
            this.busy = 'save';
            this.error = '';

            try {
                const status = await this.call('save', this.site, this.pick(this.form), this.tokenTouched ? this.token : undefined);
                this.status = status;
                this.hasToken = status.hasToken;
                this.form = { ...status.config };
                this.saved = JSON.stringify(this.pick(this.form));
                this.token = '';
                this.tokenTouched = false;
                this.$bus.$emit('message-display', { message: 'Inbox settings saved.', type: 'success', lifeTime: 3 });
            } catch (e) {
                this.error = e.message;
            } finally {
                this.busy = '';
            }
        },
        async chooseFolder () {
            const dir = await this.call('choose-folder');

            if (dir) this.form.dir = dir;
        },
        async check () {
            this.busy = 'check';
            this.error = '';

            try {
                this.preview = await this.call('check', this.site);
            } catch (e) {
                this.error = e.message;
                this.preview = null;
            } finally {
                this.busy = '';
            }
        },
        async run () {
            this.busy = 'run';
            this.error = '';

            try {
                const entry = await this.call('run', this.site);
                this.preview = null;
                await this.load(false);
                this.refreshPosts();
                this.$bus.$emit('message-display', {
                    message: entry.error ? entry.error : 'Inbox: ' + this.entrySummary(entry),
                    type: entry.error || entry.errors || entry.syncError ? 'warning' : 'success',
                    lifeTime: 5
                });
            } catch (e) {
                this.error = e.message;
            } finally {
                this.busy = '';
            }
        },
        async refreshPosts () {
            try {
                const data = await this.$plus.invoke('ai-assistant', 'agent:store-data', this.site);
                this.$store.commit('refreshAfterPostUpdate', data);
            } catch (e) {
                // lists refresh when the website is opened again
            }
        },
        actionLabel (action) {
            return { create: 'new', update: 'changed', unchanged: 'unchanged', conflict: 'conflict', skip: 'skipped', removed: 'removed', unpublish: 'to draft', error: 'error' }[action] || action;
        },
        triggerLabel (trigger) {
            return { manual: 'manual', schedule: 'automatic', agent: 'AI agent' }[trigger] || trigger;
        },
        entrySummary (entry) {
            const parts = [];

            if (entry.created) parts.push(`${entry.created} new`);
            if (entry.updated) parts.push(`${entry.updated} updated`);
            if (entry.unpublished) parts.push(`${entry.unpublished} to draft`);
            if (entry.conflicts) parts.push(`${entry.conflicts} conflict(s)`);
            if (entry.errors) parts.push(`${entry.errors} error(s)`);
            if (entry.synced) parts.push('synced');
            return parts.length ? parts.join(', ') : (entry.error ? 'failed' : 'nothing new');
        }
    }
};
</script>

<style>
.plus-inbox {
    background: var(--bg-primary);
    display: flex;
    flex-direction: column;
    inset: var(--topbar-height) 0 0 0;
    position: fixed;
    z-index: var(--layer-overlay);
}

.plus-inbox-header {
    align-items: center;
    border-bottom: 1px solid var(--color-border-subtle);
    display: flex;
    gap: var(--space-4);
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
}

.plus-inbox-title {
    display: flex;
    flex-direction: column;
}

.plus-inbox-actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
}

.plus-inbox-muted {
    color: var(--color-text-muted);
    font-size: var(--font-size-ui-sm);
}

.plus-inbox-warning {
    color: var(--color-warning);
    font-size: var(--font-size-ui-sm);
}

.plus-inbox-body {
    display: flex;
    flex: 1;
    min-height: 0;
}

.plus-inbox-settings,
.plus-inbox-results {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    overflow-y: auto;
    padding: var(--space-4);
}

.plus-inbox-settings {
    border-right: 1px solid var(--color-border-subtle);
    flex: 0 0 420px;
}

.plus-inbox-results {
    flex: 1;
    min-width: 0;
}

.plus-inbox h3 {
    font-size: var(--font-size-ui-md);
    margin: var(--space-3) 0 var(--space-1);
}

.plus-inbox-field {
    display: flex;
    flex-direction: column;
    font-size: var(--font-size-ui-sm);
    gap: var(--space-1);
}

.plus-inbox-field input,
.plus-inbox-field select {
    box-sizing: border-box;
    width: 100%;
}

.plus-inbox-row {
    display: flex;
    gap: var(--space-2);
}

.plus-inbox-row .plus-inbox-field {
    flex: 1;
}

.plus-inbox-align-end {
    align-items: flex-end;
}

.plus-inbox-switch {
    display: flex;
    gap: var(--space-4);
}

.plus-inbox-check {
    font-size: var(--font-size-ui-sm);
}

.plus-inbox-help pre {
    background: var(--bg-secondary);
    border-radius: var(--radius-base);
    font-family: var(--font-family-mono);
    font-size: var(--font-size-ui-xs);
    overflow-x: auto;
    padding: var(--space-2);
}

.plus-inbox-table {
    border-collapse: collapse;
    font-size: var(--font-size-ui-sm);
}

.plus-inbox-table td {
    border-bottom: 1px solid var(--color-border-subtle);
    padding: var(--space-1) var(--space-2);
}

.plus-inbox-path {
    font-family: var(--font-family-mono);
}

.plus-inbox-badge {
    background: var(--color-surface-subtle);
    border-radius: var(--radius-base);
    font-size: var(--font-size-ui-xs);
    padding: 0 var(--space-1);
}

.plus-inbox-badge.is-create {
    background: var(--button-secondary-bg);
    color: var(--button-secondary-color);
}

.plus-inbox-badge.is-conflict,
.plus-inbox-badge.is-error {
    background: var(--color-surface-notice);
}

.plus-inbox-entry {
    border-bottom: 1px solid var(--color-border-subtle);
    font-size: var(--font-size-ui-sm);
    padding: var(--space-2) 0;
}

.plus-inbox-entry-head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
}

.plus-inbox-items {
    margin: var(--space-1) 0 0;
    padding-left: var(--space-4);
}
</style>
