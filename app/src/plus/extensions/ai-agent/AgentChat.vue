<template>
    <div
        class="plus-agent"
        role="dialog"
        aria-label="AI agent">
        <header class="plus-agent-header">
            <div class="plus-agent-title">
                <strong>AI agent</strong>
                <span class="plus-agent-muted">{{ siteLabel }}</span>
            </div>
            <div class="plus-agent-actions">
                <p-button
                    appearance="clean"
                    :disabled="busy"
                    :onClick="newChat">New chat</p-button>
                <p-button
                    appearance="clean"
                    :onClick="() => $emit('close')">Close</p-button>
            </div>
        </header>

        <div class="plus-agent-options">
            <select
                v-if="providers.length > 1"
                v-model="providerId"
                aria-label="AI provider">
                <option
                    v-for="p in providers"
                    :key="p.id"
                    :value="p.id">{{ p.name }} · {{ p.model }}</option>
            </select>
            <span
                v-else-if="providers.length"
                class="plus-agent-muted">{{ providers[0].name }} · {{ providers[0].model }}</span>
            <label class="plus-agent-muted"><input
                v-model="autoApprove"
                type="checkbox"> Apply changes without asking</label>
        </div>

        <div
            ref="log"
            class="plus-agent-log">
            <div
                v-if="!entries.length"
                class="plus-agent-empty">
                <p v-if="providersLoaded && !providers.length">Add an AI provider in Settings → Publii Plus: AI providers first.</p>
                <template v-else>
                    <p>Ask about your website or give a task, for example:</p>
                    <button
                        v-for="example in examples"
                        :key="example"
                        type="button"
                        class="plus-agent-example"
                        @click="useExample(example)">{{ example }}</button>
                    <p class="plus-agent-muted">The agent reads posts, tags and theme files. Every change is shown to you first and can be undone. It never publishes the website.</p>
                </template>
            </div>

            <template v-for="e in entries">
                <div
                    v-if="e.type === 'user'"
                    :key="e.id"
                    class="plus-agent-msg is-user">{{ e.text }}</div>

                <div
                    v-else-if="e.type === 'assistant'"
                    :key="e.id"
                    class="plus-agent-msg is-assistant"
                    v-html="format(e.text)" />

                <div
                    v-else-if="e.type === 'error' || e.type === 'notice'"
                    :key="e.id"
                    :class="['plus-agent-note', e.type === 'error' ? 'is-error' : '']">{{ e.text }}</div>

                <div
                    v-else-if="e.type === 'tool' && !e.title"
                    :key="e.id"
                    :class="['plus-agent-step', 'is-' + e.status]">
                    <span>{{ e.status === 'error' ? '✕' : e.status === 'pending' ? '…' : '✓' }} {{ label(e.name) }}</span>
                    <span
                        v-if="e.summary || e.error"
                        class="plus-agent-muted">– {{ e.error || e.summary }}</span>
                </div>

                <div
                    v-else-if="e.type === 'tool'"
                    :key="e.id"
                    :class="['plus-agent-change', 'is-' + e.status]">
                    <div class="plus-agent-change-head">
                        <strong>{{ e.title }}</strong>
                        <span class="plus-agent-badge">{{ statusLabel(e.status) }}</span>
                    </div>
                    <ul
                        v-if="e.details && e.details.length"
                        class="plus-agent-details">
                        <li
                            v-for="(d, i) in e.details"
                            :key="i">{{ d }}</li>
                    </ul>
                    <details
                        v-if="e.diff"
                        :open="e.status === 'pending' && e.diff.length < 4000">
                        <summary>Changes</summary>
                        <pre class="plus-agent-diff"><span
                            v-for="(l, i) in diffLines(e.diff)"
                            :key="i"
                            :class="'is-' + l.kind">{{ l.text }}
</span></pre>
                    </details>
                    <div
                        v-if="e.error"
                        class="plus-agent-note is-error">{{ e.error }}</div>
                    <div
                        v-if="e.status === 'pending'"
                        class="plus-agent-change-actions">
                        <input
                            v-model="reasons[e.callId]"
                            type="text"
                            placeholder="Optional: what to do differently">
                        <p-button
                            :disabled="busy"
                            :onClick="() => decide(e, true)">Apply</p-button>
                        <p-button
                            appearance="outline"
                            :disabled="busy"
                            :onClick="() => decide(e, false)">Reject</p-button>
                    </div>
                    <div
                        v-else-if="e.status === 'applied'"
                        class="plus-agent-change-actions">
                        <p-button
                            appearance="outline"
                            :disabled="busy"
                            :onClick="() => undo(e)">Undo</p-button>
                    </div>
                </div>
            </template>

            <div
                v-if="busy"
                class="plus-agent-note">Working…</div>
        </div>

        <div
            v-if="pendingWrites.length > 1"
            class="plus-agent-bulk">
            <span class="plus-agent-muted">{{ pendingWrites.length }} changes waiting</span>
            <p-button
                :disabled="busy"
                :onClick="() => decideAll(true)">Apply all</p-button>
            <p-button
                appearance="outline"
                :disabled="busy"
                :onClick="() => decideAll(false)">Reject all</p-button>
        </div>

        <footer class="plus-agent-composer">
            <textarea
                ref="input"
                v-model="draft"
                rows="3"
                :placeholder="pendingWrites.length ? 'Apply or reject the changes above – or write what to do instead' : 'Message the agent (Ctrl+Enter to send)'"
                @keydown.enter.ctrl.prevent="send"
                @keydown.enter.meta.prevent="send" />
            <div class="plus-agent-composer-row">
                <span class="plus-agent-muted">
                    <template v-if="usage.input || usage.output">Tokens: {{ usage.input }} in / {{ usage.output }} out</template>
                </span>
                <p-button
                    v-if="busy"
                    appearance="outline"
                    :onClick="stop">Stop</p-button>
                <p-button
                    v-else
                    :disabled="!draft.trim() || !providers.length"
                    :onClick="send">Send</p-button>
            </div>
        </footer>
    </div>
</template>

<script>
import { formatAnswer, diffLines, TOOL_LABELS } from './format.js';

const EXT = 'ai-assistant';
// chats survive closing the panel and opening the post editor (the sidebar is re-created)
const sessionsBySite = {};

function clean (error) {
    return String(error && error.message ? error.message : error).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
}

export default {
    name: 'plus-agent-chat',
    data () {
        return {
            sessionId: '',
            entries: [],
            pending: [],
            usage: { input: 0, output: 0 },
            busy: false,
            draft: '',
            reasons: {},
            providers: [],
            providerId: '',
            providersLoaded: false,
            autoApprove: false,
            examples: [
                'Which posts have no meta description? Write them.',
                'Suggest tags for my latest 5 posts.',
                'Write a draft post about our news, 300 words.',
                'Add a copyright line to the footer of the theme.'
            ]
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
        pendingWrites () {
            return this.pending.filter(p => p.kind === 'write');
        }
    },
    watch: {
        site () {
            this.restore();
        }
    },
    async mounted () {
        try {
            const data = await this.call('providers:list');
            this.providers = data.providers;
            this.providerId = data.defaultProviderId || (data.providers[0] && data.providers[0].id) || '';
        } catch (e) {
            this.providers = [];
        } finally {
            this.providersLoaded = true;
        }

        await this.restore();
        this.$nextTick(() => this.$refs.input && this.$refs.input.focus());
    },
    methods: {
        call (method, ...args) {
            return this.$plus.invoke(EXT, method, ...args).catch(e => { throw new Error(clean(e)); });
        },
        format: formatAnswer,
        diffLines,
        label (name) {
            return TOOL_LABELS[name] || name;
        },
        statusLabel (status) {
            return { pending: 'waiting for you', applied: 'applied', rejected: 'rejected', undone: 'undone', error: 'failed', done: 'done' }[status] || status;
        },
        async restore () {
            this.entries = [];
            this.pending = [];
            this.usage = { input: 0, output: 0 };
            this.sessionId = sessionsBySite[this.site] || '';

            if (!this.sessionId) return;

            try {
                const out = await this.call('agent:history', this.sessionId);
                this.entries = out.entries;
                this.pending = out.pending;
                this.usage = out.usage;
                this.scroll();
            } catch (e) {
                delete sessionsBySite[this.site];
                this.sessionId = '';
            }
        },
        async ensureSession () {
            if (this.sessionId) return;

            const out = await this.call('agent:start', { site: this.site, providerId: this.providerId, autoApprove: this.autoApprove });
            this.sessionId = out.sessionId;
            sessionsBySite[this.site] = out.sessionId;
        },
        /** Merge returned entries (new ones appended, changed ones replaced). */
        apply (out) {
            for (const e of out.entries) {
                const index = this.entries.findIndex(x => x.id === e.id);

                if (index >= 0) this.entries.splice(index, 1, e);
                else this.entries.push(e);
            }

            this.pending = out.pending;
            this.usage = out.usage;
            this.refresh(out.refresh || []);
            this.scroll();
            this.runClientTools();
        },
        async run (fn) {
            this.busy = true;

            try {
                this.apply(await fn());
            } catch (e) {
                this.entries.push({ id: 'local-' + Date.now(), type: 'error', text: e.message });
                this.scroll();
            } finally {
                this.busy = false;
            }
        },
        async send () {
            const text = this.draft.trim();

            if (!text || this.busy) return;

            this.draft = '';
            await this.run(async () => {
                await this.ensureSession();
                return this.call('agent:send', this.sessionId, text, { autoApprove: this.autoApprove, providerId: this.providerId });
            });
        },
        useExample (text) {
            this.draft = text;
            this.$refs.input.focus();
        },
        decide (entry, approve) {
            const reason = (this.reasons[entry.callId] || '').trim();
            return this.run(() => this.call('agent:resolve', this.sessionId, { [entry.callId]: { approve, reason: approve ? '' : reason } }));
        },
        decideAll (approve) {
            const decisions = {};

            for (const p of this.pendingWrites) decisions[p.callId] = { approve, reason: approve ? '' : (this.reasons[p.callId] || '').trim() };
            return this.run(() => this.call('agent:resolve', this.sessionId, decisions));
        },
        undo (entry) {
            return this.run(() => this.call('agent:undo', this.sessionId, entry.id));
        },
        stop () {
            this.call('agent:cancel', this.sessionId).catch(() => {});
        },
        newChat () {
            if (this.sessionId) this.call('agent:close', this.sessionId).catch(() => {});

            delete sessionsBySite[this.site];
            this.sessionId = '';
            this.entries = [];
            this.pending = [];
            this.usage = { input: 0, output: 0 };
        },
        /** Client tools (preview) are executed here, then the agent continues. */
        runClientTools () {
            const client = this.pending.filter(p => p.kind === 'client');

            if (!client.length) return;

            const decisions = {};

            for (const p of client) {
                if (p.name === 'preview_site') {
                    this.$bus.$emit('app-menu-preview');
                    decisions[p.callId] = { approve: true, result: { ok: true, message: 'Preview rendering started; Publii opens it in the browser when ready.' } };
                } else {
                    decisions[p.callId] = { approve: false, reason: 'Not available.' };
                }
            }

            this.$nextTick(() => this.run(() => this.call('agent:resolve', this.sessionId, decisions)));
        },
        async refresh (items) {
            if (items.some(i => i.kind === 'posts')) {
                try {
                    const data = await this.call('agent:store-data', this.site);
                    this.$store.commit('refreshAfterPostUpdate', data);
                } catch (e) {
                    // the lists refresh the next time the website is opened
                }
            }
        },
        scroll () {
            this.$nextTick(() => {
                const log = this.$refs.log;

                if (log) log.scrollTop = log.scrollHeight;
            });
        }
    }
};
</script>

<style>
.plus-agent {
    background: var(--bg-primary);
    border-left: 1px solid var(--color-border-subtle);
    bottom: 0;
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    max-width: 100vw;
    position: fixed;
    right: 0;
    top: var(--topbar-height);
    width: 460px;
    z-index: var(--layer-overlay);
}

.plus-agent-header,
.plus-agent-options,
.plus-agent-bulk {
    align-items: center;
    border-bottom: 1px solid var(--color-border-subtle);
    display: flex;
    gap: var(--space-2);
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
}

.plus-agent-header {
    padding-top: var(--space-4);
}

.plus-agent-options {
    flex-wrap: wrap;
}

.plus-agent-bulk {
    border-bottom: none;
    border-top: 1px solid var(--color-border-subtle);
    justify-content: flex-end;
}

.plus-agent-title {
    display: flex;
    flex-direction: column;
}

.plus-agent-actions {
    display: flex;
    gap: var(--space-1);
}

.plus-agent-muted {
    color: var(--color-text-muted);
    font-size: var(--font-size-ui-sm);
}

.plus-agent-log {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--space-2);
    overflow-y: auto;
    padding: var(--space-4);
}

.plus-agent-empty p {
    margin: 0 0 var(--space-2);
}

.plus-agent-example {
    background: var(--button-secondary-bg);
    border: none;
    border-radius: var(--radius-base);
    color: var(--button-secondary-color);
    cursor: pointer;
    display: block;
    font: inherit;
    font-size: var(--font-size-ui-sm);
    margin-bottom: var(--space-2);
    padding: var(--space-2) var(--space-3);
    text-align: left;
    width: 100%;
}

.plus-agent-example:hover {
    background: var(--button-secondary-bg-hover);
    color: var(--button-secondary-color-hover);
}

.plus-agent-msg {
    border-radius: var(--radius-base);
    font-size: var(--font-size-ui-md);
    line-height: var(--line-height-base);
    padding: var(--space-2) var(--space-3);
    white-space: pre-wrap;
    word-break: break-word;
}

.plus-agent-msg.is-user {
    align-self: flex-end;
    background: var(--color-highlight-surface);
    max-width: 85%;
}

.plus-agent-msg.is-assistant {
    background: var(--bg-secondary);
    white-space: normal;
}

.plus-agent-msg pre {
    font-family: var(--font-family-mono);
    font-size: var(--font-size-ui-sm);
    overflow-x: auto;
}

.plus-agent-msg code {
    font-family: var(--font-family-mono);
}

.plus-agent-step {
    font-size: var(--font-size-ui-sm);
}

.plus-agent-step.is-error {
    color: var(--color-danger);
}

.plus-agent-note {
    color: var(--color-text-muted);
    font-size: var(--font-size-ui-sm);
}

.plus-agent-note.is-error {
    color: var(--color-danger);
}

.plus-agent-change {
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-base);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
}

.plus-agent-change.is-pending {
    border-color: var(--color-primary);
}

.plus-agent-change.is-rejected,
.plus-agent-change.is-undone {
    opacity: 0.7;
}

.plus-agent-change-head {
    align-items: flex-start;
    display: flex;
    gap: var(--space-2);
    justify-content: space-between;
}

.plus-agent-badge {
    background: var(--color-surface-notice);
    border-radius: var(--radius-base);
    flex-shrink: 0;
    font-size: var(--font-size-ui-xs);
    padding: 0 var(--space-1);
}

.plus-agent-details {
    font-size: var(--font-size-ui-sm);
    margin: 0;
    padding-left: var(--space-4);
}

.plus-agent-diff {
    background: var(--bg-secondary);
    border-radius: var(--radius-base);
    font-family: var(--font-family-mono);
    font-size: var(--font-size-ui-xs);
    margin: var(--space-1) 0 0;
    max-height: 320px;
    overflow: auto;
    padding: var(--space-2);
}

.plus-agent-diff .is-add {
    color: var(--color-success);
}

.plus-agent-diff .is-del {
    color: var(--color-danger);
}

.plus-agent-diff .is-hunk,
.plus-agent-diff .is-file {
    color: var(--color-text-muted);
}

.plus-agent-change-actions {
    align-items: center;
    display: flex;
    gap: var(--space-2);
}

.plus-agent-change-actions input {
    flex: 1;
    min-width: 0;
}

.plus-agent-composer {
    border-top: 1px solid var(--color-border-subtle);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
}

.plus-agent-composer textarea {
    box-sizing: border-box;
    font: inherit;
    resize: vertical;
    width: 100%;
}

.plus-agent-composer-row {
    align-items: center;
    display: flex;
    justify-content: space-between;
}
</style>
