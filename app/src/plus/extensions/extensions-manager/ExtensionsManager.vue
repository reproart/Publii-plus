<template>
    <div
        class="plus-em"
        role="dialog"
        aria-label="Extensions manager">
        <header class="plus-em-header">
            <div class="plus-em-title">
                <strong>Extensions manager</strong>
                <span class="plus-em-muted">Publii Plus · install and update {{ typeLabel }} from catalogs or links</span>
            </div>
            <div class="plus-em-actions">
                <p-button
                    appearance="clean"
                    :onClick="() => $emit('close')">Close</p-button>
            </div>
        </header>

        <nav class="plus-em-tabs">
            <button
                v-for="t in tabs"
                :key="t.id"
                type="button"
                :class="{ 'is-active': tab === t.id }"
                @click="tab = t.id">{{ t.label }}</button>
        </nav>

        <div class="plus-em-body">
            <!-- Catalog -->
            <section v-if="tab === 'catalog'">
                <div class="plus-em-toolbar">
                    <input
                        v-model="filter"
                        type="search"
                        placeholder="Search…">
                    <select v-model="typeFilter">
                        <option value="">Plugins and themes</option>
                        <option value="plugin">Plugins</option>
                        <option value="theme">Themes</option>
                    </select>
                    <label><input
                        type="checkbox"
                        v-model="onlyUpdates"> Updates only ({{ updates.length }})</label>
                    <p-button
                        appearance="outline"
                        :loading="loading"
                        :onClick="load">Refresh</p-button>
                    <p-button
                        v-if="updates.length"
                        :disabled="!!busy"
                        :onClick="updateAll">Update all ({{ updates.length }})</p-button>
                </div>

                <div
                    v-for="group in catalog"
                    :key="group.source.id"
                    class="plus-em-source">
                    <h3>{{ group.source.name }}</h3>
                    <div
                        v-if="group.error"
                        class="msg msg-small msg-alert">{{ group.error }}</div>

                    <div
                        v-for="item in visible(group.items)"
                        :key="item.type + item.id"
                        class="plus-em-item is-catalog">
                        <div class="plus-em-item-action">
                            <span
                                v-if="item.status === 'installed'"
                                class="plus-em-muted">Installed</span>
                            <span
                                v-else-if="item.status === 'newer-installed'"
                                class="plus-em-muted">Installed v{{ item.installed }}</span>
                            <p-button
                                v-else
                                :appearance="item.status === 'update' ? 'default' : 'outline'"
                                :loading="busy === item.sourceId + item.id"
                                :disabled="!!busy"
                                :onClick="() => install(item)">{{ item.status === 'update' ? 'Update from v' + item.installed : 'Install' }}</p-button>
                        </div>
                        <div class="plus-em-item-info">
                            <div>
                                <strong>{{ item.name }}</strong>
                                <span class="plus-em-chip">{{ item.type }}</span>
                                <span class="plus-em-muted">{{ item.id }} · v{{ item.version }}<template v-if="item.author"> · {{ item.author }}</template></span>
                            </div>
                            <p class="plus-em-desc">{{ item.description }}</p>
                        </div>
                    </div>

                    <p
                        v-if="!group.error && !visible(group.items).length"
                        class="plus-em-muted">Nothing to show.</p>
                </div>

                <p
                    v-if="loading && !catalog.length"
                    class="plus-em-muted">Loading catalogs…</p>
            </section>

            <!-- Install from link -->
            <section v-if="tab === 'link'">
                <p class="plus-em-muted">
                    A link to a .zip file or a GitHub repository (https://github.com/owner/repo). The archive is checked
                    before anything is installed.
                </p>
                <div class="plus-em-toolbar">
                    <input
                        v-model="link"
                        class="plus-em-wide"
                        type="url"
                        placeholder="https://github.com/owner/repository"
                        @keydown.enter="inspect">
                    <p-button
                        :loading="busy === 'inspect'"
                        :disabled="!!busy || !link.trim()"
                        :onClick="inspect">Check</p-button>
                </div>

                <div
                    v-if="inspected"
                    class="plus-em-inspected">
                    <p>
                        <strong>{{ inspected.name || 'Unknown' }}</strong>
                        <span
                            v-if="inspected.type"
                            class="plus-em-chip">{{ inspected.type }}</span>
                        <span class="plus-em-muted">v{{ inspected.version }}</span>
                    </p>
                    <p class="plus-em-desc">{{ inspected.description }}</p>
                    <div
                        v-for="(e, i) in inspected.errors"
                        :key="'e' + i"
                        class="msg msg-small msg-alert">{{ e }}</div>
                    <div
                        v-for="(w, i) in inspected.warnings"
                        :key="'w' + i"
                        class="plus-em-muted">Warning: {{ w }}</div>

                    <template v-if="!inspected.errors.length">
                        <label class="plus-em-label">
                            Install as (folder name – keep it the same for future updates)
                            <input
                                v-model="installId"
                                type="text">
                        </label>
                        <p
                            v-if="installedVersionForId"
                            class="plus-em-muted">Already installed: v{{ installedVersionForId }} – it will be replaced.</p>
                        <div class="plus-em-toolbar">
                            <p-button
                                :loading="busy === 'install-link'"
                                :disabled="!!busy || !installId.trim()"
                                :onClick="installInspected">Install</p-button>
                            <p-button
                                appearance="outline"
                                :onClick="cancelInspected">Cancel</p-button>
                        </div>
                    </template>
                </div>
            </section>

            <!-- Sources -->
            <section v-if="tab === 'sources'">
                <p class="plus-em-muted">
                    Catalogs are GitHub releases with a catalog.json (see publii_modified, workflow "Publish catalog")
                    or a direct link to a catalog.json. Private repositories need a GitHub token with read access to
                    the repository contents; it is stored in the system keychain.
                </p>

                <div
                    v-for="s in sources"
                    :key="s.id"
                    class="plus-em-item">
                    <div class="plus-em-item-info">
                        <strong>{{ s.name }}</strong>
                        <span class="plus-em-muted">
                            <template v-if="s.type === 'github'">github.com/{{ s.owner }}/{{ s.repo }} · release "{{ s.tag }}"</template>
                            <template v-else>{{ s.url }}</template>
                            · {{ s.hasToken ? 'token saved' : 'no token' }}
                        </span>
                    </div>
                    <div class="plus-em-item-action">
                        <p-button
                            appearance="outline"
                            :onClick="() => editSource(s)">Edit</p-button>
                        <p-button
                            appearance="clean"
                            :onClick="() => removeSource(s)">Remove</p-button>
                    </div>
                </div>

                <p-button
                    v-if="!sourceForm"
                    appearance="outline"
                    :onClick="() => editSource(null)">Add source</p-button>

                <div
                    v-if="sourceForm"
                    class="plus-em-form">
                    <label class="plus-em-label">Type
                        <select v-model="sourceForm.type">
                            <option value="github">GitHub release</option>
                            <option value="url">catalog.json URL</option>
                        </select>
                    </label>
                    <label class="plus-em-label">Name
                        <input
                            v-model="sourceForm.name"
                            type="text"
                            placeholder="optional">
                    </label>
                    <template v-if="sourceForm.type === 'github'">
                        <label class="plus-em-label">Owner
                            <input
                                v-model="sourceForm.owner"
                                type="text"
                                placeholder="reproart">
                        </label>
                        <label class="plus-em-label">Repository
                            <input
                                v-model="sourceForm.repo"
                                type="text"
                                placeholder="publii_modified">
                        </label>
                        <label class="plus-em-label">Release tag
                            <input
                                v-model="sourceForm.tag"
                                type="text"
                                placeholder="catalog">
                        </label>
                    </template>
                    <label
                        v-else
                        class="plus-em-label">catalog.json URL
                        <input
                            v-model="sourceForm.url"
                            type="url"
                            placeholder="https://example.com/catalog.json">
                    </label>
                    <label class="plus-em-label">Access token
                        <input
                            v-model="sourceForm.token"
                            type="password"
                            :placeholder="sourceForm.hasToken ? 'Saved – leave empty to keep' : 'Only for private repositories'">
                    </label>
                    <label
                        v-if="sourceForm.hasToken"
                        class="plus-em-muted"><input
                            type="checkbox"
                            v-model="sourceForm.removeToken"> Remove the saved token</label>
                    <div class="plus-em-toolbar">
                        <p-button :onClick="saveSource">Save source</p-button>
                        <p-button
                            appearance="clean"
                            :onClick="() => { sourceForm = null; }">Cancel</p-button>
                    </div>
                </div>
            </section>
        </div>
    </div>
</template>

<script>
const EXT_ID = 'extensions-manager';

function clean (error) {
    return String(error && error.message ? error.message : error).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
}

export default {
    name: 'plus-extensions-manager',
    props: {
        type: { type: String, default: '' },
        startTab: { type: String, default: 'catalog' }
    },
    data () {
        return {
            tab: this.startTab,
            tabs: [
                { id: 'catalog', label: 'Catalog' },
                { id: 'link', label: 'Install from link' },
                { id: 'sources', label: 'Sources' }
            ],
            catalog: [],
            loading: false,
            busy: '',
            filter: '',
            typeFilter: this.type,
            onlyUpdates: false,
            link: '',
            inspected: null,
            installId: '',
            sources: [],
            sourceForm: null
        };
    },
    computed: {
        typeLabel () {
            return this.type === 'theme' ? 'themes' : this.type === 'plugin' ? 'plugins' : 'plugins and themes';
        },
        updates () {
            return this.catalog.flatMap(g => g.items).filter(i => i.status === 'update' && (!this.typeFilter || i.type === this.typeFilter));
        },
        installedVersionForId () {
            if (!this.inspected || !this.installId.trim()) return null;

            const id = this.installId.trim();
            const list = this.inspected.type === 'theme' ? this.$store.state.themes : this.$store.state.plugins;
            const found = (list || []).find(e => e.directory === id);

            return found ? found.version : null;
        }
    },
    watch: {
        tab (value) {
            if (value === 'sources') this.loadSources();
        }
    },
    mounted () {
        this.load();
    },
    methods: {
        call (method, ...args) {
            return this.$plus.invoke(EXT_ID, method, ...args).catch(e => { throw new Error(clean(e)); });
        },
        notify (message, type = 'success') {
            this.$bus.$emit('message-display', { message, type, lifeTime: type === 'success' ? 3 : 7 });
        },
        visible (items) {
            const q = this.filter.trim().toLowerCase();

            return items.filter(i => (!this.typeFilter || i.type === this.typeFilter) &&
                (!this.onlyUpdates || i.status === 'update') &&
                (!q || (i.name + ' ' + i.id + ' ' + (i.description || '')).toLowerCase().includes(q)));
        },
        async load () {
            this.loading = true;

            try {
                this.catalog = await this.call('catalog');
                this.$emit('updates', this.catalog.flatMap(g => g.items).filter(i => i.status === 'update').length);
            } catch (e) {
                this.notify(e.message, 'warning');
            } finally {
                this.loading = false;
            }
        },
        async install (item) {
            this.busy = item.sourceId + item.id;

            try {
                const out = await this.call('install', item.sourceId, item.id);
                this.notify(`${item.name} ${out.status === 'updated' ? 'updated to' : 'installed:'} v${out.version}.`);
                await this.load();
            } catch (e) {
                this.notify(`${item.name}: ${e.message}`, 'warning');
            } finally {
                this.busy = '';
            }
        },
        async updateAll () {
            for (const item of this.updates.slice()) {
                await this.install(item);
            }
        },
        async inspect () {
            if (this.inspected) await this.cancelInspected();

            this.busy = 'inspect';

            try {
                this.inspected = await this.call('inspect-url', this.link.trim());
                this.installId = this.inspected.suggestedId;
            } catch (e) {
                this.notify(e.message, 'warning');
            } finally {
                this.busy = '';
            }
        },
        async installInspected () {
            this.busy = 'install-link';

            try {
                const out = await this.call('install-inspected', this.inspected.token, this.installId.trim());
                this.notify(`${this.inspected.name} ${out.status === 'updated' ? 'updated' : 'installed'} as "${out.id}".`);
                this.inspected = null;
                this.link = '';
                await this.load();
            } catch (e) {
                this.notify(e.message, 'warning');

                if (/Inspect the link again/.test(e.message)) this.inspected = null;
            } finally {
                this.busy = '';
            }
        },
        async cancelInspected () {
            if (this.inspected) await this.call('cancel-inspected', this.inspected.token).catch(() => {});

            this.inspected = null;
        },
        async loadSources () {
            try {
                this.sources = await this.call('sources');
            } catch (e) {
                this.notify(e.message, 'warning');
            }
        },
        editSource (s) {
            this.sourceForm = s
                ? { ...s, token: '', removeToken: false }
                : { type: 'github', name: '', owner: '', repo: '', tag: 'catalog', url: '', token: '', hasToken: false, removeToken: false };
        },
        async saveSource () {
            const f = this.sourceForm;
            const input = { id: f.id, type: f.type, name: f.name, owner: f.owner, repo: f.repo, tag: f.tag, url: f.url };

            if (f.token.trim()) input.token = f.token.trim();
            else if (f.removeToken) input.token = '';

            try {
                await this.call('sources:save', input);
                this.sourceForm = null;
                await this.loadSources();
                await this.load();
                this.notify('Source saved.');
            } catch (e) {
                this.notify(e.message, 'warning');
            }
        },
        async removeSource (s) {
            if (!window.confirm(`Remove the source "${s.name}"? Installed extensions stay installed.`)) return;

            await this.call('sources:remove', s.id);
            await this.loadSources();
            await this.load();
        }
    }
};
</script>

<style>
.plus-em {
    background: var(--bg-primary);
    display: flex;
    flex-direction: column;
    inset: var(--topbar-height) 0 0 0;
    position: fixed;
    z-index: var(--layer-overlay);
}

.plus-em-header {
    align-items: center;
    border-bottom: 1px solid var(--color-border-subtle);
    display: flex;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4) var(--space-3) var(--space-16);
}

.plus-em-title {
    display: flex;
    flex-direction: column;
}

.plus-em-actions,
.plus-em-toolbar {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
}

.plus-em-toolbar {
    margin-bottom: var(--space-4);
}

.plus-em-wide {
    flex: 1;
    min-width: 320px;
}

.plus-em-tabs {
    border-bottom: 1px solid var(--color-border-subtle);
    display: flex;
    gap: var(--space-4);
    padding: 0 var(--space-16);
}

.plus-em-tabs button {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
    padding: var(--space-3) 0;
}

.plus-em-tabs button.is-active {
    border-bottom-color: var(--color-primary);
    color: var(--color-primary);
    font-weight: var(--font-weight-semibold);
}

.plus-em-body {
    flex: 1;
    overflow: auto;
    padding: var(--space-6) var(--space-16);
}

.plus-em-muted {
    color: var(--color-text-muted);
    font-size: var(--font-size-ui-sm);
}

.plus-em-source h3 {
    font-size: var(--font-size-ui-md);
    margin: var(--space-6) 0 var(--space-2);
}

.plus-em-item {
    align-items: center;
    border-bottom: 1px solid var(--color-border-subtle);
    display: flex;
    gap: var(--space-4);
    justify-content: space-between;
    padding: var(--space-3) 0;
}

.plus-em-item-info {
    min-width: 0;
}

/* catalog: the action comes first, in a fixed column, so it stays next to the name on wide windows */
.plus-em-item.is-catalog {
    align-items: flex-start;
    justify-content: flex-start;
}

.plus-em-item.is-catalog .plus-em-item-action {
    justify-content: flex-start;
    width: 150px;
}

.plus-em-item-action {
    display: flex;
    flex-shrink: 0;
    gap: var(--space-2);
}

.plus-em-desc {
    color: var(--color-text-muted);
    font-size: var(--font-size-ui-sm);
    margin: var(--space-1) 0 0;
    max-width: 760px;
}

.plus-em-chip {
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-base);
    font-size: var(--font-size-ui-xs);
    margin: 0 var(--space-2);
    padding: 0 var(--space-1);
}

.plus-em-inspected,
.plus-em-form {
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-base);
    max-width: 720px;
    padding: var(--space-4);
}

.plus-em-label {
    display: block;
    margin-bottom: var(--space-3);
}

.plus-em-label input,
.plus-em-label select {
    box-sizing: border-box;
    display: block;
    margin-top: var(--space-1);
    width: 100%;
}
</style>
