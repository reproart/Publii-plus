<template>
    <div
        class="plus-ws"
        role="dialog"
        aria-label="Plugin workshop">
        <header class="plus-ws-header">
            <div class="plus-ws-title">
                <strong>Plugin workshop</strong>
                <span class="plus-ws-muted">Your copies and new plugins · edits are used by the next render, no restart needed</span>
            </div>
            <div class="plus-ws-actions">
                <label class="plus-ws-muted"><input
                    type="checkbox"
                    :checked="hookLog.enabled"
                    @change="setHookLog($event.target.checked)"> Record hook log</label>
                <p-button
                    :appearance="view === 'log' ? 'default' : 'outline'"
                    :onClick="showLog">Hook log</p-button>
                <p-button
                    appearance="clean"
                    :onClick="close">Close</p-button>
            </div>
        </header>

        <div class="plus-ws-body">
            <aside class="plus-ws-col">
                <div class="plus-ws-heading">Your plugins</div>
                <button
                    v-for="p in workshopPlugins"
                    :key="p.id"
                    type="button"
                    :class="{ 'plus-ws-item': true, 'is-active': selected === p.id }"
                    @click="select(p.id)">
                    <span>{{ p.name }}</span>
                    <span class="plus-ws-muted">{{ p.id }}<template v-if="p.origin"> · copy of {{ p.origin.name }} v{{ p.origin.version }}</template><template v-else> · new</template></span>
                </button>
                <p
                    v-if="!workshopPlugins.length"
                    class="plus-ws-muted">No plugins yet – copy one or create a new one below.</p>

                <div class="plus-ws-form">
                    <div class="plus-ws-heading">Copy a plugin</div>
                    <select v-model="copySource">
                        <option value="">Choose an installed plugin…</option>
                        <option
                            v-for="p in installedPlugins"
                            :key="p.id"
                            :value="p.id">{{ p.name }} (v{{ p.version }})</option>
                    </select>
                    <input
                        v-model="copyId"
                        type="text"
                        placeholder="Folder name of the copy">
                    <p-button
                        appearance="outline"
                        :disabled="!copySource || !copyId.trim()"
                        :onClick="makeCopy">Make my copy</p-button>
                </div>

                <div class="plus-ws-form">
                    <div class="plus-ws-heading">New plugin</div>
                    <input
                        v-model="newId"
                        type="text"
                        placeholder="Folder name, e.g. readingTime">
                    <input
                        v-model="newName"
                        type="text"
                        placeholder="Name, e.g. Reading time">
                    <input
                        v-model="newAuthor"
                        type="text"
                        placeholder="Author">
                    <p-button
                        appearance="outline"
                        :disabled="!newId.trim()"
                        :onClick="createPlugin">Create</p-button>
                </div>
            </aside>

            <aside
                v-if="selected && view === 'edit'"
                class="plus-ws-col plus-ws-files">
                <div class="plus-ws-heading">Files</div>
                <button
                    v-for="f in files"
                    :key="f.path"
                    type="button"
                    :class="{ 'plus-ws-file': true, 'is-active': current && current.path === f.path, 'is-changed': f.changed }"
                    :title="f.path"
                    @click="openFile(f.path)">
                    <span class="plus-ws-name">{{ f.path }}</span>
                    <span
                        v-if="f.added"
                        class="plus-ws-badge">new</span>
                    <span
                        v-else-if="f.changed"
                        class="plus-ws-badge">changed</span>
                </button>
                <div class="plus-ws-form">
                    <input
                        v-model="newFile"
                        type="text"
                        placeholder="front-assets/script.js"
                        @keydown.enter="createFile">
                    <p-button
                        appearance="outline"
                        :disabled="!newFile.trim()"
                        :onClick="createFile">New file</p-button>
                </div>
            </aside>

            <section class="plus-ws-main">
                <!-- Hook log -->
                <template v-if="view === 'log'">
                    <div class="plus-ws-toolbar">
                        <div>
                            <strong>Hook log</strong>
                            <span class="plus-ws-muted">
                                <template v-if="hookLog.log">last render of "{{ hookLog.log.site }}" · {{ new Date(hookLog.log.finishedAt).toLocaleString() }}</template>
                                <template v-else>no log yet</template>
                            </span>
                        </div>
                        <div class="plus-ws-actions">
                            <p-button
                                appearance="outline"
                                :onClick="refreshLog">Refresh</p-button>
                            <p-button
                                appearance="outline"
                                :onClick="clearLog">Clear</p-button>
                            <p-button
                                appearance="clean"
                                :onClick="() => { view = 'edit'; }">Back to files</p-button>
                        </div>
                    </div>
                    <p
                        v-if="!hookLog.enabled"
                        class="plus-ws-note">Turn on "Record hook log", then render the website (Preview). Every plugin hook call is measured.</p>
                    <table
                        v-if="hookLog.log && hookLog.log.entries.length"
                        class="plus-ws-table">
                        <thead>
                            <tr>
                                <th>Plugin</th><th>Type</th><th>Hook</th><th>Calls</th><th>Changed</th><th>Total ms</th><th>Max ms</th><th>Errors</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr
                                v-for="(e, i) in hookLog.log.entries"
                                :key="i"
                                :class="{ 'is-error': e.errors }">
                                <td>{{ e.plugin }}</td><td>{{ e.type }}</td><td>{{ e.hook }}</td><td>{{ e.calls }}</td>
                                <td>{{ e.type === 'modifiers' ? e.changed : '–' }}</td><td>{{ e.totalMs }}</td><td>{{ e.maxMs }}</td>
                                <td :title="e.lastError">{{ e.errors || '' }}<template v-if="e.lastError"> – {{ e.lastError }}</template></td>
                            </tr>
                        </tbody>
                    </table>
                </template>

                <!-- Editing -->
                <template v-else-if="selected">
                    <div class="plus-ws-toolbar">
                        <div>
                            <strong>{{ selectedPlugin && selectedPlugin.name }}</strong>
                            <span class="plus-ws-muted">{{ selected }}</span>
                        </div>
                        <div class="plus-ws-actions">
                            <p-button
                                appearance="outline"
                                :loading="checking"
                                :onClick="check">Check plugin</p-button>
                            <p-button
                                v-if="meta && meta.kind === 'copy'"
                                appearance="outline"
                                :onClick="exportDiff">Export changes (.diff)</p-button>
                            <p-button
                                appearance="outline"
                                :onClick="exportZip">Export .zip</p-button>
                            <p-button
                                appearance="clean"
                                :onClick="removePlugin">Delete</p-button>
                        </div>
                    </div>

                    <div
                        v-if="checkResult"
                        class="plus-ws-check">
                        <div :class="['msg', 'msg-small', checkResult.ok ? 'msg-info' : 'msg-alert']">
                            {{ checkResult.ok ? 'The plugin loads correctly.' : 'Problems found:' }}
                            <template v-if="checkResult.hooks">
                                Hooks: {{ hookSummary }}
                            </template>
                        </div>
                        <div
                            v-for="(e, i) in checkResult.errors"
                            :key="'e' + i"
                            class="plus-ws-problem is-error">{{ e }}</div>
                        <div
                            v-for="(w, i) in checkResult.warnings"
                            :key="'w' + i"
                            class="plus-ws-problem is-warning">{{ w }}</div>
                    </div>

                    <template v-if="current">
                        <div class="plus-ws-toolbar">
                            <div class="plus-ws-path">
                                {{ current.path }}
                                <span
                                    v-if="dirty"
                                    class="plus-ws-badge">unsaved</span>
                            </div>
                            <div class="plus-ws-actions">
                                <p-button
                                    :disabled="!dirty"
                                    :onClick="save">Save</p-button>
                                <p-button
                                    v-if="current.original !== null"
                                    appearance="outline"
                                    :onClick="toggleCompare">{{ compare ? 'Edit' : 'Compare with original' }}</p-button>
                                <p-button
                                    v-if="current.path !== 'plugin.json' && current.path !== 'main.js'"
                                    appearance="clean"
                                    :onClick="deleteFile">Delete file</p-button>
                            </div>
                        </div>
                        <div
                            v-for="(p, i) in problems"
                            :key="'p' + i"
                            :class="['plus-ws-problem', p.kind === 'error' ? 'is-error' : 'is-warning']">
                            {{ p.kind === 'error' ? 'Error' : 'Warning' }}<template v-if="p.line"> (line {{ p.line }})</template>: {{ p.message }}
                        </div>
                        <div class="plus-ws-editor">
                            <plus-code-editor
                                v-if="!compare"
                                :key="'e-' + selected + current.path"
                                v-model="content"
                                :fileName="current.path"
                                @save="save" />
                            <plus-code-editor
                                v-else
                                :key="'d-' + selected + current.path"
                                :value="compareText"
                                mode="diff"
                                readonly />
                        </div>
                    </template>
                    <p
                        v-else
                        class="plus-ws-note">Choose a file.</p>
                </template>

                <div
                    v-else
                    class="plus-ws-note">
                    <p>Make your own copy of an installed plugin to change it safely – the original stays untouched and
                        can still be updated. "Export changes" creates a .diff you can send to the plugin's author.</p>
                    <p class="plus-ws-muted">Publii renders in a separate process and loads the plugin code fresh every time,
                        so saved changes are used by the next preview or sync without restarting.</p>
                </div>
            </section>
        </div>
    </div>
</template>

<script>
import PlusCodeEditor from '../../components/PlusCodeEditor.vue';
import { createDiff } from '../theme-editor/diff-client.js';

const EXT_ID = 'plugin-workshop';

function clean (error) {
    return String(error && error.message ? error.message : error).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
}

export default {
    name: 'plus-plugin-workshop',
    components: { PlusCodeEditor },
    data () {
        return {
            view: 'edit',
            plugins: [],
            selected: '',
            meta: null,
            files: [],
            current: null,
            content: '',
            compare: false,
            compareText: '',
            problems: [],
            checkResult: null,
            checking: false,
            copySource: '',
            copyId: '',
            newId: '',
            newName: '',
            newAuthor: '',
            newFile: '',
            hookLog: { enabled: false, log: null }
        };
    },
    computed: {
        workshopPlugins () {
            return this.plugins.filter(p => p.workshop);
        },
        installedPlugins () {
            return this.plugins.filter(p => !p.workshop);
        },
        selectedPlugin () {
            return this.plugins.find(p => p.id === this.selected);
        },
        dirty () {
            return !!this.current && this.content !== this.current.content;
        },
        hookSummary () {
            const h = this.checkResult.hooks;
            const parts = [...h.modifiers.map(n => 'modifier ' + n), ...h.insertions.map(n => 'insertion ' + n), ...h.events.map(n => 'event ' + n)];
            return parts.length ? parts.join(', ') : 'none';
        }
    },
    watch: {
        copySource (id) {
            if (id && !this.copyId) this.copyId = id + 'My';
        }
    },
    async mounted () {
        await this.refresh();
        this.hookLog = await this.call('hook-log');
    },
    methods: {
        call (method, ...args) {
            return this.$plus.invoke(EXT_ID, method, ...args).catch(e => { throw new Error(clean(e)); });
        },
        notify (message, type = 'success') {
            this.$bus.$emit('message-display', { message, type, lifeTime: type === 'success' ? 3 : 7 });
        },
        async run (fn) {
            try {
                return await fn();
            } catch (e) {
                this.notify(e.message, 'warning');
                return null;
            }
        },
        async refresh () {
            const out = await this.run(() => this.call('list'));

            if (out) this.plugins = out.plugins;
        },
        confirmDiscard () {
            return !this.dirty || window.confirm('Discard unsaved changes in ' + this.current.path + '?');
        },
        async select (id) {
            if (!this.confirmDiscard()) return;

            this.view = 'edit';
            this.selected = id;
            this.current = null;
            this.checkResult = null;
            await this.loadFiles();

            const main = this.files.find(f => f.path === 'main.js');

            if (main) await this.openFile('main.js');
        },
        async loadFiles () {
            const out = await this.run(() => this.call('files', this.selected));

            if (out) {
                this.files = out.files;
                this.meta = out.meta;
            }
        },
        async openFile (rel) {
            if (this.current && this.current.path === rel) return;
            if (!this.confirmDiscard()) return;

            const file = await this.run(() => this.call('read', this.selected, rel));

            if (file) {
                this.current = file;
                this.content = file.content;
                this.compare = false;
                this.problems = [];
            }
        },
        async save () {
            if (!this.dirty) return;

            const out = await this.run(() => this.call('save', this.selected, this.current.path, this.content));

            if (!out) return;

            this.problems = [...out.errors.map(p => ({ ...p, kind: 'error' })), ...out.warnings.map(p => ({ ...p, kind: 'warning' }))];

            if (!out.ok) {
                this.notify('Not saved: fix the errors first.', 'warning');
                return;
            }

            this.current = { ...this.current, content: this.content };
            await this.loadFiles();

            if (this.current.path === 'plugin.json') await this.refresh();

            this.notify('Saved – the next render uses it.');
        },
        toggleCompare () {
            this.compare = !this.compare;

            if (this.compare) this.compareText = createDiff(this.current.original, this.content, this.current.path) || 'No differences.';
        },
        async createFile () {
            const rel = this.newFile.trim();
            const out = await this.run(() => this.call('create-file', this.selected, rel));

            if (out) {
                this.newFile = '';
                await this.loadFiles();
                await this.openFile(out.path);
            }
        },
        async deleteFile () {
            if (!window.confirm(`Delete ${this.current.path}?`)) return;

            const out = await this.run(() => this.call('delete-file', this.selected, this.current.path));

            if (out) {
                this.current = null;
                await this.loadFiles();
            }
        },
        async makeCopy () {
            const id = this.copyId.trim();
            const out = await this.run(() => this.call('copy', this.copySource, id));

            if (out) {
                this.copySource = '';
                this.copyId = '';
                await this.refresh();
                await this.select(id);
                this.notify('Copy created. It appears in the plugin list and can be enabled per website.');
            }
        },
        async createPlugin () {
            const id = this.newId.trim();
            const out = await this.run(() => this.call('create', id, this.newName.trim(), this.newAuthor.trim()));

            if (out) {
                this.newId = '';
                this.newName = '';
                await this.refresh();
                await this.select(id);
            }
        },
        async check () {
            this.checking = true;

            try {
                this.checkResult = await this.call('check', this.selected);
            } catch (e) {
                this.notify(e.message, 'warning');
            } finally {
                this.checking = false;
            }
        },
        async exportDiff () {
            const out = await this.run(() => this.call('export-diff', this.selected));

            if (out && out.ok) this.notify(`Exported ${out.files} file(s) to ${out.filePath}`);
            else if (out && !out.canceled) this.notify(out.message, 'warning');
        },
        async exportZip () {
            const out = await this.run(() => this.call('export-zip', this.selected));

            if (out && out.ok) this.notify('Saved ' + out.filePath);
        },
        async removePlugin () {
            if (!window.confirm(`Delete the plugin "${this.selected}"? This cannot be undone.`)) return;

            const out = await this.run(() => this.call('remove', this.selected));

            if (out) {
                this.selected = '';
                this.current = null;
                await this.refresh();
            }
        },
        async setHookLog (enabled) {
            this.hookLog = await this.call('hook-log:set', enabled);
        },
        async refreshLog () {
            this.hookLog = await this.call('hook-log');
        },
        async clearLog () {
            this.hookLog = await this.call('hook-log:clear');
        },
        async showLog () {
            if (!this.confirmDiscard()) return;

            await this.refreshLog();
            this.view = 'log';
        },
        close () {
            if (this.confirmDiscard()) this.$emit('close');
        }
    }
};
</script>

<style>
.plus-ws {
    background: var(--bg-primary);
    display: flex;
    flex-direction: column;
    inset: 0;
    position: fixed;
    z-index: var(--layer-overlay);
}

.plus-ws-header,
.plus-ws-toolbar {
    align-items: center;
    border-bottom: 1px solid var(--color-border-subtle);
    display: flex;
    gap: var(--space-4);
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
}

.plus-ws-header {
    padding-left: var(--space-16);
}

.plus-ws-title {
    display: flex;
    flex-direction: column;
}

.plus-ws-actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
}

.plus-ws-muted {
    color: var(--color-text-muted);
    font-size: var(--font-size-ui-sm);
}

.plus-ws-body {
    display: flex;
    flex: 1;
    min-height: 0;
}

.plus-ws-col {
    border-right: 1px solid var(--color-border-subtle);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    overflow: auto;
    padding: var(--space-3);
    width: 260px;
}

.plus-ws-files {
    width: 230px;
}

.plus-ws-heading {
    color: var(--color-text-muted);
    font-size: var(--font-size-ui-xs);
    font-weight: var(--font-weight-semibold);
    margin: var(--space-2) 0 var(--space-1);
    text-transform: uppercase;
}

.plus-ws-item,
.plus-ws-file {
    background: none;
    border: none;
    border-radius: var(--radius-base);
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    font-size: var(--font-size-ui-sm);
    gap: var(--space-1);
    padding: var(--space-1) var(--space-2);
    text-align: left;
    width: 100%;
}

.plus-ws-item {
    flex-direction: column;
}

.plus-ws-file {
    align-items: center;
    justify-content: space-between;
}

.plus-ws-item:hover,
.plus-ws-file:hover {
    background: var(--color-surface-subtle);
}

.plus-ws-item.is-active,
.plus-ws-file.is-active {
    background: var(--color-highlight-surface);
}

.plus-ws-file.is-changed .plus-ws-name {
    font-weight: var(--font-weight-semibold);
}

.plus-ws-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.plus-ws-badge {
    background: var(--color-surface-notice);
    border-radius: var(--radius-base);
    font-size: var(--font-size-ui-xs);
    padding: 0 var(--space-1);
}

.plus-ws-form {
    border-top: 1px solid var(--color-border-subtle);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-3);
    padding-top: var(--space-2);
}

.plus-ws-form input,
.plus-ws-form select {
    box-sizing: border-box;
    width: 100%;
}

.plus-ws-main {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    overflow: auto;
}

.plus-ws-path {
    font-family: var(--font-family-mono);
    font-size: var(--font-size-ui-sm);
}

.plus-ws-check {
    border-bottom: 1px solid var(--color-border-subtle);
    padding: var(--space-2) var(--space-4);
}

.plus-ws-problem {
    font-size: var(--font-size-ui-sm);
    padding: var(--space-1) var(--space-4);
}

.plus-ws-problem.is-error {
    color: var(--color-danger);
}

.plus-ws-problem.is-warning {
    color: var(--color-warning);
}

.plus-ws-editor {
    flex: 1;
    min-height: 320px;
}

.plus-ws-note {
    margin: var(--space-8) auto;
    max-width: 560px;
    padding: 0 var(--space-4);
}

.plus-ws-table {
    border-collapse: collapse;
    font-size: var(--font-size-ui-sm);
    margin: var(--space-4);
}

.plus-ws-table th,
.plus-ws-table td {
    border-bottom: 1px solid var(--color-border-subtle);
    padding: var(--space-1) var(--space-3);
    text-align: left;
}

.plus-ws-table tr.is-error td {
    color: var(--color-danger);
}
</style>
