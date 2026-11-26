<template>
    <div
        class="plus-tr"
        role="dialog"
        aria-label="Translations">
        <header class="plus-tr-header">
            <div class="plus-tr-title">
                <strong>Translations</strong>
                <span class="plus-tr-muted">{{ siteLabel }}<template v-if="status && status.languageName"> · {{ status.languageName }}</template> · posts are translated into language websites</span>
            </div>
            <div class="plus-tr-actions">
                <p-button
                    v-if="!status || !status.translationOf"
                    :loading="busy === 'run' || (status && status.running)"
                    :disabled="!!busy || dirty || !hasTargets || (status && status.running)"
                    :onClick="run">Translate now</p-button>
                <p-button
                    appearance="clean"
                    :onClick="() => $emit('close')">Close</p-button>
            </div>
        </header>

        <div
            v-if="status && status.translationOf"
            class="plus-tr-body plus-tr-single">
            <p>This website receives translations from <strong>{{ status.translationOf }}</strong>. Open that website to change the settings or to translate posts.</p>
            <p class="plus-tr-muted">Translated posts can be edited here – they are not overwritten unless you choose "Overwrite" on the main website. Render and sync this website as usual to publish the translations.</p>
        </div>

        <div
            v-else
            class="plus-tr-body">
            <section class="plus-tr-settings">
                <h3>Language websites</h3>
                <p
                    v-if="status && !status.language"
                    class="plus-tr-warning">Set the language of this website first (Site settings → Language).</p>
                <p
                    v-if="status && !status.websites.length"
                    class="plus-tr-muted">Create one Publii website per language (with its language set in Site settings), then choose them here.</p>
                <div
                    v-for="w in (status ? status.websites : [])"
                    :key="w.site"
                    class="plus-tr-site">
                    <label
                        class="plus-tr-check"
                        :class="{ 'is-disabled': !!unavailable(w) }"><input
                            type="checkbox"
                            :checked="isTarget(w.site)"
                            :disabled="!!unavailable(w) && !isTarget(w.site)"
                            @change="toggleTarget(w.site, $event.target.checked)">
                        {{ w.name }} <span class="plus-tr-muted">({{ w.site }}) · {{ w.languageName || 'no language set' }}</span></label>
                    <span
                        v-if="unavailable(w)"
                        class="plus-tr-muted plus-tr-indent">{{ unavailable(w) }}</span>
                    <label
                        v-if="isTarget(w.site)"
                        class="plus-tr-field plus-tr-indent">Glossary and notes for the translator (optional)
                        <textarea
                            v-model="target(w.site).glossary"
                            rows="3"
                            placeholder="cardiology = кардиология&#10;Keep product names in English. Address readers formally." /></label>
                </div>

                <h3>AI model</h3>
                <label class="plus-tr-field">Provider
                    <select v-model="form.providerId">
                        <option value="">Default provider</option>
                        <option
                            v-for="p in providers"
                            :key="p.id"
                            :value="p.id">{{ p.name }}{{ p.model ? ' – ' + p.model : '' }}</option>
                    </select></label>
                <p
                    v-if="!providers.length"
                    class="plus-tr-warning">Add an AI provider in Settings → AI providers.</p>

                <h3>Schedule</h3>
                <label class="plus-tr-check"><input
                    v-model="form.enabled"
                    type="checkbox"> Translate automatically while Publii Plus is open</label>
                <div class="plus-tr-row">
                    <label
                        v-if="form.enabled"
                        class="plus-tr-field">Every (minutes)
                        <input
                            v-model.number="form.intervalMinutes"
                            type="number"
                            min="5"
                            max="1440"></label>
                    <label class="plus-tr-field">Translations per run (at most)
                        <input
                            v-model.number="form.maxPerRun"
                            type="number"
                            min="1"
                            max="200"></label>
                </div>

                <div class="plus-tr-actions">
                    <p-button
                        :disabled="!dirty"
                        :loading="busy === 'save'"
                        :onClick="save">Save settings</p-button>
                    <span
                        v-if="dirty"
                        class="plus-tr-muted">Unsaved changes</span>
                </div>

                <details class="plus-tr-help">
                    <summary>How it works</summary>
                    <ul>
                        <li>Every published post gets a translated copy in each language website: with the same slug (/en/cardiology/ → /ru/cardiology/), date, featured image, images and flags. It is published right away.</li>
                        <li>Tags are translated once per language and keep the slug of the original tag. Links between posts point to the translated posts.</li>
                        <li>When a post changes, it is translated again; status, slug and date changes are copied without a new translation. Drafts are not translated.</li>
                        <li>A translation edited in the language website is not overwritten – use "Overwrite" when you want the new translation. A post that already exists there with the same slug is kept as the translation.</li>
                        <li>Nothing is published by itself: render and sync each language website when you are ready (switch to it in the websites list).</li>
                    </ul>
                </details>
            </section>

            <section class="plus-tr-results">
                <div
                    v-if="status && status.running && status.progress"
                    class="msg msg-small msg-info">
                    Translating “{{ status.progress.title }}” into {{ status.progress.target }}<template v-if="status.progress.pieces"> ({{ status.progress.pieces }})</template> –
                    {{ status.progress.done + 1 }} of {{ status.progress.total }}…
                </div>
                <div
                    v-if="error || (status && status.planError)"
                    class="msg msg-small msg-alert">{{ error || status.planError }}</div>

                <template v-if="savedTargets.length && posts.length">
                    <div class="plus-tr-summary">
                        <span
                            v-for="t in savedTargets"
                            :key="t">
                            <strong>{{ t }}</strong>: {{ countsText(t) }}</span>
                    </div>
                    <label class="plus-tr-check"><input
                        v-model="attentionOnly"
                        type="checkbox"> Only posts that need attention</label>
                    <table class="plus-tr-table">
                        <thead>
                            <tr>
                                <th>Post</th>
                                <th
                                    v-for="t in savedTargets"
                                    :key="t">{{ t }}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr
                                v-for="post in visiblePosts"
                                :key="post.sourceId">
                                <td class="plus-tr-post">{{ post.title || '(no title)' }}</td>
                                <td
                                    v-for="t in savedTargets"
                                    :key="t">
                                    <template v-if="post.cells[t]">
                                        <span
                                            :class="'plus-tr-badge is-' + tone(post.cells[t])"
                                            :title="post.cells[t].error || post.cells[t].reason">{{ label(post.cells[t]) }}</span>
                                        <span
                                            v-if="post.cells[t].unresolved"
                                            class="plus-tr-muted"
                                            title="Links to posts or pages that do not exist in this website yet"> · {{ post.cells[t].unresolved }} link(s) waiting</span>
                                        <a
                                            v-if="canOverwrite(post.cells[t])"
                                            href="#"
                                            class="plus-tr-link"
                                            @click.prevent="overwrite(post.cells[t])">{{ post.cells[t].error ? 'Retry' : 'Overwrite' }}</a>
                                        <a
                                            v-if="post.cells[t].state === 'deleted'"
                                            href="#"
                                            class="plus-tr-link"
                                            @click.prevent="forget(post.cells[t])">Translate again</a>
                                    </template>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                    <p
                        v-if="!visiblePosts.length"
                        class="plus-tr-muted">All translations are up to date.</p>
                </template>
                <p
                    v-else-if="!savedTargets.length"
                    class="plus-tr-muted">Choose the language websites and save the settings.</p>

                <h3>History</h3>
                <p
                    v-if="!status || !status.log.length"
                    class="plus-tr-muted">No translations yet.</p>
                <div
                    v-for="(entry, i) in (status ? status.log : [])"
                    :key="entry.at + '-' + i"
                    class="plus-tr-entry">
                    <div class="plus-tr-entry-head">
                        <strong>{{ new Date(entry.at).toLocaleString() }}</strong>
                        <span class="plus-tr-muted">{{ triggerLabel(entry.trigger) }}</span>
                        <span>{{ entrySummary(entry) }}</span>
                        <span
                            v-if="entry.usage && (entry.usage.input || entry.usage.output)"
                            class="plus-tr-muted">{{ entry.usage.input + entry.usage.output }} tokens</span>
                    </div>
                    <div
                        v-if="entry.error"
                        class="plus-tr-warning">{{ entry.error }}</div>
                    <ul
                        v-if="entry.items && entry.items.length"
                        class="plus-tr-items">
                        <li
                            v-for="(item, j) in entry.items"
                            :key="j">
                            {{ actionLabel(item.action) }} “{{ item.title }}” → {{ item.target }}
                            <span
                                v-if="item.error"
                                class="plus-tr-warning">– {{ item.error }}</span>
                            <span
                                v-else-if="item.note"
                                class="plus-tr-muted">– {{ item.note }}</span>
                        </li>
                    </ul>
                </div>
            </section>
        </div>
    </div>
</template>

<script>
import { stateLabel, stateTone, entrySummary, triggerLabel } from './labels.js';

const EXT = 'translations';
const FIELDS = ['enabled', 'providerId', 'intervalMinutes', 'maxPerRun', 'targets'];

function clean (error) {
    return String(error && error.message ? error.message : error).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
}

export default {
    name: 'plus-translations',
    data () {
        return {
            status: null,
            providers: [],
            form: { enabled: false, providerId: '', intervalMinutes: 30, maxPerRun: 10, targets: [] },
            saved: '',
            busy: '',
            error: '',
            attentionOnly: false,
            timer: null
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
            return JSON.stringify(this.pick(this.form)) !== this.saved;
        },
        hasTargets () {
            return this.savedTargets.length > 0;
        },
        savedTargets () {
            return this.status ? this.status.config.targets.map(t => t.site) : [];
        },
        posts () {
            const map = new Map();

            for (const item of (this.status ? this.status.items : [])) {
                if (!map.has(item.sourceId)) map.set(item.sourceId, { sourceId: item.sourceId, title: item.title, cells: {} });
                map.get(item.sourceId).cells[item.target] = item;
            }

            return [...map.values()].reverse();
        },
        visiblePosts () {
            if (!this.attentionOnly) return this.posts;
            return this.posts.filter(p => Object.values(p.cells).some(c => c.error || c.unresolved || ['new', 'outdated', 'edited', 'deleted'].includes(c.state)));
        }
    },
    async mounted () {
        await Promise.all([this.load(true), this.loadProviders()]);
        this.schedule();
    },
    beforeDestroy () {
        clearTimeout(this.timer);
    },
    methods: {
        call (method, ...args) {
            return this.$plus.invoke(EXT, method, ...args).catch(e => { throw new Error(clean(e)); });
        },
        pick (form) {
            const out = {};

            for (const key of FIELDS) out[key] = form[key];
            out.targets = (form.targets || []).map(t => ({ site: t.site, glossary: t.glossary || '' }));
            return out;
        },
        // a scheduled run may start while the dialog is open: refresh often while translating
        schedule () {
            clearTimeout(this.timer);
            this.timer = setTimeout(async () => {
                await this.load(false);
                this.schedule();
            }, this.status && this.status.running ? 2000 : 15000);
        },
        async load (resetForm) {
            try {
                const status = await this.call('status', this.site);
                this.status = status;

                if (resetForm) {
                    this.form = JSON.parse(JSON.stringify(status.config));
                    this.saved = JSON.stringify(this.pick(this.form));
                }
            } catch (e) {
                this.error = e.message;
            }
        },
        async loadProviders () {
            try {
                const data = await this.$plus.invoke('ai-assistant', 'providers:list');
                this.providers = data.providers || [];
            } catch (e) {
                this.providers = [];
            }
        },
        isTarget (site) {
            return this.form.targets.some(t => t.site === site);
        },
        target (site) {
            return this.form.targets.find(t => t.site === site);
        },
        toggleTarget (site, on) {
            if (on && !this.isTarget(site)) this.form.targets.push({ site, glossary: '' });
            if (!on) this.form.targets = this.form.targets.filter(t => t.site !== site);
        },
        unavailable (w) {
            if (!w.language) return 'Set its language in Site settings first.';
            if (this.status && w.language.toLowerCase() === String(this.status.language).toLowerCase()) return 'Same language as this website.';
            if (w.mainOf) return 'Not available: ' + w.mainOf + '.';
            return '';
        },
        async save () {
            this.busy = 'save';
            this.error = '';

            try {
                this.status = await this.call('save', this.site, this.pick(this.form));
                this.form = JSON.parse(JSON.stringify(this.status.config));
                this.saved = JSON.stringify(this.pick(this.form));
                this.$bus.$emit('message-display', { message: 'Translation settings saved.', type: 'success', lifeTime: 3 });
            } catch (e) {
                this.error = e.message;
            } finally {
                this.busy = '';
            }
        },
        async run () {
            await this.action('run', () => this.call('run', this.site));
        },
        async overwrite (item) {
            await this.action('run', () => this.call('overwrite', this.site, item.sourceId, item.target));
        },
        async forget (item) {
            this.error = '';

            try {
                this.status = await this.call('forget', this.site, item.sourceId, item.target);
            } catch (e) {
                this.error = e.message;
            }
        },
        async action (name, fn) {
            this.busy = name;
            this.error = '';

            const poll = setInterval(() => this.load(false), 2000);

            try {
                const entry = await fn();
                await this.load(false);
                this.$bus.$emit('message-display', {
                    message: entry.error ? entry.error : 'Translations: ' + entrySummary(entry) + (entry.created || entry.updated ? '. Sync the language websites to publish them.' : '.'),
                    type: entry.error || entry.errors ? 'warning' : 'success',
                    lifeTime: 6
                });
            } catch (e) {
                this.error = e.message;
            } finally {
                clearInterval(poll);
                this.busy = '';
            }
        },
        canOverwrite (item) {
            return !!item.error || ['edited', 'linked'].includes(item.state);
        },
        countsText (target) {
            const counts = {};

            for (const item of (this.status ? this.status.items : [])) {
                if (item.target !== target) continue;

                const label = stateLabel(item);
                counts[label] = (counts[label] || 0) + 1;
            }

            return Object.entries(counts).map(([label, n]) => `${n} ${label}`).join(', ');
        },
        label: stateLabel,
        tone: stateTone,
        entrySummary,
        triggerLabel,
        actionLabel (action) {
            return { create: 'Translated', update: 'Updated', meta: 'Copied changes of', link: 'Linked', unpublish: 'Unpublished' }[action] || action;
        }
    }
};
</script>

<style>
.plus-tr {
    background: var(--bg-primary);
    display: flex;
    flex-direction: column;
    inset: var(--topbar-height) 0 0 0;
    position: fixed;
    z-index: var(--layer-overlay);
}

.plus-tr-header {
    align-items: center;
    border-bottom: 1px solid var(--color-border-subtle);
    display: flex;
    gap: var(--space-4);
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
}

.plus-tr-title {
    display: flex;
    flex-direction: column;
}

.plus-tr-actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
}

.plus-tr-muted {
    color: var(--color-text-muted);
    font-size: var(--font-size-ui-sm);
}

.plus-tr-warning {
    color: var(--color-warning);
    font-size: var(--font-size-ui-sm);
}

.plus-tr-body {
    display: flex;
    flex: 1;
    min-height: 0;
}

.plus-tr-single {
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-6);
}

.plus-tr-settings,
.plus-tr-results {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    overflow-y: auto;
    padding: var(--space-4);
}

.plus-tr-settings {
    border-right: 1px solid var(--color-border-subtle);
    flex: 0 0 420px;
}

.plus-tr-results {
    flex: 1;
    min-width: 0;
}

.plus-tr h3 {
    font-size: var(--font-size-ui-md);
    margin: var(--space-3) 0 var(--space-1);
}

.plus-tr-site {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
}

.plus-tr-indent {
    padding-left: var(--space-6);
}

.plus-tr-field {
    display: flex;
    flex-direction: column;
    font-size: var(--font-size-ui-sm);
    gap: var(--space-1);
}

.plus-tr-field input,
.plus-tr-field select,
.plus-tr-field textarea {
    box-sizing: border-box;
    width: 100%;
}

.plus-tr-row {
    display: flex;
    gap: var(--space-2);
}

.plus-tr-row .plus-tr-field {
    flex: 1;
}

.plus-tr-check {
    font-size: var(--font-size-ui-sm);
}

.plus-tr-check.is-disabled {
    color: var(--color-text-muted);
}

.plus-tr-help {
    font-size: var(--font-size-ui-sm);
}

.plus-tr-help ul {
    margin: var(--space-1) 0 0;
    padding-left: var(--space-4);
}

.plus-tr-summary {
    display: flex;
    flex-wrap: wrap;
    font-size: var(--font-size-ui-sm);
    gap: var(--space-4);
}

.plus-tr-table {
    border-collapse: collapse;
    font-size: var(--font-size-ui-sm);
    width: 100%;
}

.plus-tr-table th {
    font-weight: var(--font-weight-semibold);
    text-align: left;
}

.plus-tr-table th,
.plus-tr-table td {
    border-bottom: 1px solid var(--color-border-subtle);
    padding: var(--space-1) var(--space-2);
    vertical-align: top;
}

.plus-tr-post {
    max-width: 360px;
}

.plus-tr-link {
    margin-left: var(--space-2);
}

.plus-tr-badge {
    background: var(--color-surface-subtle);
    border-radius: var(--radius-base);
    font-size: var(--font-size-ui-xs);
    padding: 0 var(--space-1);
    white-space: nowrap;
}

.plus-tr-badge.is-todo {
    background: var(--button-secondary-bg);
    color: var(--button-secondary-color);
}

.plus-tr-badge.is-notice,
.plus-tr-badge.is-error {
    background: var(--color-surface-notice);
}

.plus-tr-badge.is-error {
    color: var(--color-warning);
}

.plus-tr-badge.is-muted {
    color: var(--color-text-muted);
}

.plus-tr-entry {
    border-bottom: 1px solid var(--color-border-subtle);
    font-size: var(--font-size-ui-sm);
    padding: var(--space-2) 0;
}

.plus-tr-entry-head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
}

.plus-tr-items {
    margin: var(--space-1) 0 0;
    padding-left: var(--space-4);
}
</style>
