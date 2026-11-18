<template>
    <div
        class="plus-te"
        role="dialog"
        aria-label="Theme files">
        <header class="plus-te-header">
            <div class="plus-te-title">
                <strong>Theme files</strong>
                <span class="plus-te-muted">{{ theme }} · changes are saved as overrides and survive theme updates</span>
            </div>
            <div class="plus-te-actions">
                <p-button
                    appearance="outline"
                    :onClick="preview">Preview site</p-button>
                <p-button
                    appearance="outline"
                    :disabled="!overriddenCount"
                    :onClick="exportDiff">Export changes (.diff)</p-button>
                <p-button
                    appearance="clean"
                    :onClick="close">Close</p-button>
            </div>
        </header>

        <div class="plus-te-body">
            <aside class="plus-te-tree">
                <input
                    v-model="filter"
                    class="plus-te-filter"
                    type="search"
                    placeholder="Filter files…">
                <label class="plus-te-only">
                    <input
                        type="checkbox"
                        v-model="onlyChanged"> Changed only ({{ overriddenCount }})
                </label>

                <div
                    v-for="group in groups"
                    :key="group.dir"
                    class="plus-te-group">
                    <button
                        v-if="group.dir"
                        type="button"
                        class="plus-te-dir"
                        :aria-expanded="isOpen(group.dir) ? 'true' : 'false'"
                        @click="toggleDir(group.dir)">{{ isOpen(group.dir) ? '▾' : '▸' }} {{ group.dir }}/ <span class="plus-te-count">{{ group.files.length }}</span></button>
                    <button
                        v-for="file in (isOpen(group.dir) ? group.files : [])"
                        :key="file.path"
                        type="button"
                        :class="{ 'plus-te-file': true, 'is-active': current && current.path === file.path, 'is-changed': file.overridden }"
                        :title="file.path"
                        @click="open(file.path)">
                        <span class="plus-te-name">{{ file.name }}</span>
                        <span
                            v-if="file.onlyInOverride"
                            class="plus-te-badge">new</span>
                        <span
                            v-else-if="file.overridden"
                            class="plus-te-badge">changed</span>
                    </button>
                </div>

                <p
                    v-if="!groups.length"
                    class="plus-te-muted">No files.</p>

                <div class="plus-te-new">
                    <input
                        v-model="newPath"
                        type="text"
                        placeholder="partials/my-block.hbs"
                        @keydown.enter="createFile">
                    <p-button
                        appearance="outline"
                        :disabled="!newPath.trim()"
                        :onClick="createFile">New file</p-button>
                </div>
            </aside>

            <section class="plus-te-main">
                <template v-if="current">
                    <div class="plus-te-toolbar">
                        <div class="plus-te-path">
                            {{ current.path }}
                            <span
                                v-if="current.original === null"
                                class="plus-te-badge">new file</span>
                            <span
                                v-else-if="current.override !== null"
                                class="plus-te-badge">changed</span>
                            <span
                                v-if="dirty"
                                class="plus-te-badge is-dirty">unsaved</span>
                        </div>
                        <div class="plus-te-actions">
                            <p-button
                                :disabled="!dirty || saving"
                                :loading="saving"
                                :onClick="save">Save</p-button>
                            <p-button
                                v-if="current.original !== null"
                                appearance="outline"
                                :disabled="current.override === null && !dirty"
                                :onClick="toggleCompare">{{ compare ? 'Edit' : 'Compare with original' }}</p-button>
                            <p-button
                                v-if="current.override !== null"
                                appearance="outline"
                                :onClick="revert">{{ current.original === null ? 'Delete file' : 'Revert to original' }}</p-button>
                        </div>
                    </div>

                    <div
                        v-if="problems.length"
                        class="plus-te-problems">
                        <button
                            v-for="(p, i) in problems"
                            :key="i"
                            type="button"
                            :class="['plus-te-problem', p.kind === 'error' ? 'is-error' : 'is-warning']"
                            @click="jump(p.line)">
                            {{ p.kind === 'error' ? 'Error' : 'Warning' }}<template v-if="p.line"> (line {{ p.line }})</template>: {{ p.message }}
                        </button>
                    </div>

                    <div class="plus-te-editor">
                        <plus-code-editor
                            v-if="!compare"
                            ref="editor"
                            :key="'edit-' + current.path"
                            v-model="content"
                            :fileName="current.path"
                            @save="save" />
                        <plus-code-editor
                            v-else
                            :key="'diff-' + current.path"
                            :value="compareText"
                            mode="diff"
                            readonly />
                    </div>
                </template>

                <div
                    v-else
                    class="plus-te-empty">
                    <p>Choose a file on the left.</p>
                    <p class="plus-te-muted">
                        Edits never change the theme itself: Publii uses the edited copy from
                        <code>{{ theme }}-override</code> and keeps it when the theme is updated.
                        "Revert to original" removes the edited copy.
                    </p>
                </div>
            </section>
        </div>
    </div>
</template>

<script>
import PlusCodeEditor from '../../components/PlusCodeEditor.vue';
import { createDiff } from './diff-client.js';

const EXT_ID = 'theme-editor';

function clean (error) {
    return String(error && error.message ? error.message : error).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
}

export default {
    name: 'plus-theme-editor',
    components: { PlusCodeEditor },
    props: ['siteName'],
    data () {
        return {
            theme: '',
            files: [],
            filter: '',
            onlyChanged: false,
            current: null,
            content: '',
            saving: false,
            compare: false,
            compareText: '',
            problems: [],
            newPath: '',
            openDirs: { partials: true },
            validateTimer: null
        };
    },
    computed: {
        dirty () {
            return !!this.current && this.content !== (this.current.override !== null ? this.current.override : this.current.original);
        },
        overriddenCount () {
            return this.files.filter(f => f.overridden).length;
        },
        groups () {
            const q = this.filter.trim().toLowerCase();
            const map = new Map();

            for (const f of this.files) {
                if (this.onlyChanged && !f.overridden) continue;
                if (q && !f.path.toLowerCase().includes(q)) continue;

                const i = f.path.lastIndexOf('/');
                const dir = i === -1 ? '' : f.path.slice(0, i);

                if (!map.has(dir)) map.set(dir, []);
                map.get(dir).push({ ...f, name: i === -1 ? f.path : f.path.slice(i + 1) });
            }

            // templates first, then partials, then the rest alphabetically
            const rank = dir => (dir === '' ? 0 : dir === 'partials' ? 1 : 2);

            return [...map.entries()]
                .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
                .map(([dir, files]) => ({ dir, files }));
        }
    },
    watch: {
        content () {
            this.scheduleValidation();
        }
    },
    async mounted () {
        document.addEventListener('keydown', this.onKey);
        await this.refreshList();
    },
    beforeDestroy () {
        clearTimeout(this.validateTimer);
        document.removeEventListener('keydown', this.onKey);
    },
    methods: {
        isOpen (dir) {
            // root, searches and "changed only" always show everything
            return dir === '' || !!this.filter.trim() || this.onlyChanged || !!this.openDirs[dir] ||
                (!!this.current && this.current.path.startsWith(dir + '/'));
        },
        toggleDir (dir) {
            this.$set(this.openDirs, dir, !this.isOpen(dir));
        },
        scheduleValidation () {
            clearTimeout(this.validateTimer);

            if (!this.current) return;

            const rel = this.current.path;
            const text = this.content;

            this.validateTimer = setTimeout(async () => {
                try {
                    const out = await this.call('validate', rel, text);

                    if (this.current && this.current.path === rel && this.content === text) {
                        this.problems = [
                            ...out.errors.map(p => ({ ...p, kind: 'error' })),
                            ...out.warnings.map(p => ({ ...p, kind: 'warning' }))
                        ];
                    }
                } catch (e) {
                    // validation is advisory here; saving validates again
                }
            }, 600);
        },
        call (method, ...args) {
            return this.$plus.invoke(EXT_ID, method, ...args).catch(e => { throw new Error(clean(e)); });
        },
        notify (message, type = 'success') {
            this.$bus.$emit('message-display', { message, type, lifeTime: type === 'success' ? 3 : 6 });
        },
        onKey (event) {
            if (event.key === 'Escape' && !this.compare) this.close();
        },
        async refreshList () {
            try {
                const out = await this.call('list', this.siteName);
                this.theme = out.theme;
                this.files = out.files;
            } catch (e) {
                this.notify(e.message, 'warning');
            }
        },
        confirmDiscard () {
            return !this.dirty || window.confirm('Discard unsaved changes in ' + this.current.path + '?');
        },
        async open (rel) {
            if (this.current && this.current.path === rel) return;
            if (!this.confirmDiscard()) return;

            try {
                const file = await this.call('read', this.siteName, rel);
                this.current = file;
                this.content = file.content;
                this.compare = false;
                this.problems = [];
            } catch (e) {
                this.notify(e.message, 'warning');
            }
        },
        async save () {
            if (!this.current || !this.dirty || this.saving) return;

            this.saving = true;

            try {
                const out = await this.call('save', this.siteName, this.current.path, this.content);
                this.problems = [
                    ...(out.errors || []).map(p => ({ ...p, kind: 'error' })),
                    ...(out.warnings || []).map(p => ({ ...p, kind: 'warning' }))
                ];

                if (!out.ok) {
                    this.notify('Not saved: fix the errors first.', 'warning');
                    return;
                }

                this.current = await this.call('read', this.siteName, this.current.path);
                await this.refreshList();
                this.notify(out.overridden ? 'Saved. Use "Preview site" to see the change.' : 'Same as the original – the edited copy was removed.');
            } catch (e) {
                this.notify(e.message, 'warning');
            } finally {
                this.saving = false;
            }
        },
        async revert () {
            const isNew = this.current.original === null;
            const question = isNew ? `Delete ${this.current.path}?` : `Revert ${this.current.path} to the theme's original? Your changes in this file will be lost.`;

            if (!window.confirm(question)) return;

            try {
                await this.call('revert', this.siteName, this.current.path);
                await this.refreshList();

                if (isNew) {
                    this.current = null;
                } else {
                    this.current = await this.call('read', this.siteName, this.current.path);
                    this.content = this.current.content;
                }

                this.compare = false;
                this.problems = [];
                this.notify(isNew ? 'File deleted.' : 'Reverted to the original.');
            } catch (e) {
                this.notify(e.message, 'warning');
            }
        },
        async toggleCompare () {
            if (this.compare) {
                this.compare = false;
                return;
            }

            // compare the current editor content (also unsaved) with the theme's original
            this.compareText = createDiff(this.current.original, this.content, this.current.path) || 'No differences.';
            this.compare = true;
        },
        async createFile () {
            const rel = this.newPath.trim();

            if (!rel || !this.confirmDiscard()) return;

            try {
                await this.call('create', this.siteName, rel);
                this.newPath = '';
                await this.refreshList();
                this.current = null;
                await this.open(rel.replace(/^\/+/, ''));
            } catch (e) {
                this.notify(e.message, 'warning');
            }
        },
        async exportDiff () {
            try {
                const out = await this.call('export-diff', this.siteName);

                if (out.ok) this.notify(`Exported ${out.files} file(s) to ${out.filePath}`);
                else if (!out.canceled) this.notify(out.message, 'warning');
            } catch (e) {
                this.notify(e.message, 'warning');
            }
        },
        jump (line) {
            if (this.compare) this.compare = false;

            this.$nextTick(() => this.$refs.editor && this.$refs.editor.jumpToLine(line));
        },
        preview () {
            if (this.dirty && !window.confirm('The current file has unsaved changes. Preview without them?')) return;

            this.$bus.$emit('app-menu-preview');
        },
        close () {
            if (!this.confirmDiscard()) return;

            this.$emit('close');
        }
    }
};
</script>

<style>
.plus-te {
    background: var(--bg-primary);
    display: flex;
    flex-direction: column;
    inset: 0;
    position: fixed;
    z-index: var(--layer-overlay);
}

.plus-te-header,
.plus-te-toolbar {
    align-items: center;
    border-bottom: 1px solid var(--color-border-subtle);
    display: flex;
    gap: var(--space-4);
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
}

.plus-te-header {
    padding-left: var(--space-16);
}

.plus-te-title {
    display: flex;
    flex-direction: column;
}

.plus-te-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
}

.plus-te-muted {
    color: var(--color-text-muted);
    font-size: var(--font-size-ui-sm);
}

.plus-te-body {
    display: flex;
    flex: 1;
    min-height: 0;
}

.plus-te-tree {
    border-right: 1px solid var(--color-border-subtle);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    overflow: auto;
    padding: var(--space-3);
    width: 280px;
}

.plus-te-filter,
.plus-te-new input {
    box-sizing: border-box;
    width: 100%;
}

.plus-te-only {
    font-size: var(--font-size-ui-sm);
    margin-bottom: var(--space-2);
}

.plus-te-dir {
    background: none;
    border: none;
    color: var(--color-text-muted);
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-ui-xs);
    margin: var(--space-2) 0 var(--space-1);
    padding: 0;
    text-align: left;
}

.plus-te-count {
    color: var(--color-text-faint);
}

.plus-te-file {
    align-items: center;
    background: none;
    border: none;
    border-radius: var(--radius-base);
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    font-size: var(--font-size-ui-sm);
    gap: var(--space-1);
    justify-content: space-between;
    padding: var(--space-1) var(--space-2);
    text-align: left;
    width: 100%;
}

.plus-te-file:hover {
    background: var(--color-surface-subtle);
}

.plus-te-file.is-active {
    background: var(--color-highlight-surface);
}

.plus-te-file.is-changed .plus-te-name {
    font-weight: var(--font-weight-semibold);
}

.plus-te-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.plus-te-badge {
    background: var(--color-surface-notice);
    border-radius: var(--radius-base);
    font-size: var(--font-size-ui-xs);
    font-weight: var(--font-weight-regular);
    margin-left: var(--space-1);
    padding: 0 var(--space-1);
}

.plus-te-badge.is-dirty {
    background: var(--color-highlight-surface);
}

.plus-te-new {
    border-top: 1px solid var(--color-border-subtle);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: auto;
    padding-top: var(--space-3);
}

.plus-te-main {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
}

.plus-te-path {
    font-family: var(--font-family-mono);
    font-size: var(--font-size-ui-sm);
}

.plus-te-problems {
    border-bottom: 1px solid var(--color-border-subtle);
    display: flex;
    flex-direction: column;
    max-height: 120px;
    overflow: auto;
}

.plus-te-problem {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-ui-sm);
    padding: var(--space-1) var(--space-4);
    text-align: left;
}

.plus-te-problem.is-error {
    color: var(--color-danger);
}

.plus-te-problem.is-warning {
    color: var(--color-warning);
}

.plus-te-editor {
    flex: 1;
    min-height: 0;
}

.plus-te-empty {
    margin: auto;
    max-width: 480px;
    text-align: center;
}
</style>
