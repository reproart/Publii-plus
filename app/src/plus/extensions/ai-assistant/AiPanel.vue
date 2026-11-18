<template>
    <div class="options-sidebar-item plus-ai-panel">
        <div
            :class="{ 'options-sidebar-header': true, 'is-open': open }"
            @click="open = !open">
            <icon
                class="options-sidebar-icon"
                size="s"
                name="pen-ai-suggestion"/>
            <span class="options-sidebar-label">AI Assistant</span>
        </div>

        <div
            class="post-editor-settings"
            :style="open ? 'max-height: none; overflow: visible;' : ''">
            <div class="post-editor-settings-content plus-ai">
                <template v-if="!providersLoaded">
                    <p class="plus-ai-muted">Loading…</p>
                </template>

                <template v-else-if="!providers.length">
                    <p>No AI provider is configured yet.</p>
                    <p-button
                        appearance="outline"
                        :onClick="openSettings">Add a provider in Settings</p-button>
                </template>

                <template v-else>
                    <label
                        v-if="providers.length > 1"
                        class="plus-ai-provider">
                        Provider
                        <select v-model="providerId">
                            <option
                                v-for="p in providers"
                                :key="p.id"
                                :value="p.id">{{ p.name }} – {{ p.model }}</option>
                        </select>
                    </label>

                    <div class="plus-ai-tabs">
                        <button
                            v-for="tab in tabs"
                            :key="tab.id"
                            type="button"
                            :class="{ 'is-active': activeTab === tab.id }"
                            @click="activeTab = tab.id">{{ tab.label }}</button>
                    </div>

                    <!-- SEO -->
                    <div v-if="activeTab === 'seo'">
                        <p class="plus-ai-muted">Meta title, meta description and slug from the post content.</p>
                        <p-button
                            :loading="busy === 'seo'"
                            :disabled="!!busy"
                            :onClick="runSeo">Generate SEO</p-button>

                        <div
                            v-if="seo"
                            class="plus-ai-result">
                            <div
                                v-for="row in seoRows"
                                :key="row.key"
                                class="plus-ai-row">
                                <div class="plus-ai-row-head">
                                    <strong>{{ row.label }}</strong>
                                    <span :class="{ 'plus-ai-count': true, 'is-over': row.limit && seo[row.key].length > row.limit }">{{ seo[row.key].length }}<template v-if="row.limit"> / {{ row.limit }}</template></span>
                                </div>
                                <textarea
                                    v-model="seo[row.key]"
                                    rows="2"
                                    spellcheck="true"></textarea>
                                <div class="plus-ai-row-buttons">
                                    <span
                                        v-if="row.current"
                                        class="plus-ai-muted"
                                        :title="row.current">current: {{ shorten(row.current) }}</span>
                                    <button
                                        type="button"
                                        class="plus-ai-link"
                                        @click="applySeo(row.key)">Apply</button>
                                </div>
                            </div>
                            <p-button
                                appearance="outline"
                                :onClick="() => applySeo()">Apply all</p-button>
                        </div>
                    </div>

                    <!-- Tags -->
                    <div v-if="activeTab === 'tags'">
                        <p class="plus-ai-muted">Existing tags of the website are preferred.</p>
                        <p-button
                            :loading="busy === 'tags'"
                            :disabled="!!busy"
                            :onClick="runTags">Suggest tags</p-button>

                        <div
                            v-if="tagSuggestions"
                            class="plus-ai-result">
                            <label
                                v-for="tag in tagSuggestions.tags"
                                :key="tag.name"
                                class="plus-ai-tag">
                                <input
                                    type="checkbox"
                                    v-model="tag.selected">
                                {{ tag.name }}
                                <span
                                    v-if="tag.isNew"
                                    class="plus-ai-new">new</span>
                                <span
                                    v-if="tag.name === tagSuggestions.mainTag"
                                    class="plus-ai-muted">main</span>
                            </label>
                            <p-button
                                appearance="outline"
                                :onClick="() => applyTags()">Add selected tags</p-button>
                        </div>
                    </div>

                    <!-- Write -->
                    <div v-if="activeTab === 'write'">
                        <textarea
                            v-model="brief"
                            rows="4"
                            placeholder="What should the post be about? Key points, audience, links…"></textarea>
                        <div class="plus-ai-inline">
                            <select v-model="draftLength">
                                <option value="short">Short (~300 words)</option>
                                <option value="medium">Medium (~700 words)</option>
                                <option value="long">Long (~1500 words)</option>
                            </select>
                            <input
                                v-model="tone"
                                type="text"
                                placeholder="Tone (optional)">
                        </div>
                        <label class="plus-ai-check">
                            <input
                                type="checkbox"
                                v-model="fullPost">
                            Also create title, SEO fields and tags
                        </label>
                        <p-button
                            :loading="busy === 'draft' || busy === 'post'"
                            :disabled="!!busy || !brief.trim()"
                            :onClick="runDraft">{{ fullPost ? 'Write post' : 'Write draft' }}</p-button>

                        <div
                            v-if="draft"
                            class="plus-ai-result">
                            <strong>{{ draft.title }}</strong>

                            <dl
                                v-if="draft.seo"
                                class="plus-ai-summary">
                                <dt>Meta title</dt>
                                <dd>{{ draft.seo.metaTitle }} <span class="plus-ai-muted">({{ draft.seo.metaTitle.length }}/70)</span></dd>
                                <dt>Meta description</dt>
                                <dd>{{ draft.seo.metaDescription }} <span class="plus-ai-muted">({{ draft.seo.metaDescription.length }}/160)</span></dd>
                                <dt>Slug</dt>
                                <dd>{{ draft.seo.slug }}</dd>
                                <dt>Tags</dt>
                                <dd>
                                    <span
                                        v-for="tag in draft.tags"
                                        :key="tag.name"
                                        class="plus-ai-chip">{{ tag.name }}<span
                                            v-if="tag.isNew"
                                            class="plus-ai-new">new</span></span>
                                </dd>
                            </dl>

                            <div
                                class="plus-ai-preview"
                                v-html="draftPreview"></div>

                            <div class="plus-ai-buttons">
                                <p-button
                                    v-if="draft.seo"
                                    :onClick="applyEverything">Apply everything</p-button>
                                <p-button
                                    v-if="adapter.canInsert"
                                    :appearance="draft.seo ? 'outline' : 'default'"
                                    :onClick="() => insertDraft(true)">Replace content</p-button>
                                <p-button
                                    v-if="adapter.canInsert"
                                    appearance="outline"
                                    :onClick="() => insertDraft(false)">Insert at cursor</p-button>
                                <p-button
                                    appearance="outline"
                                    :onClick="useTitle">Use title</p-button>
                                <p-button
                                    appearance="outline"
                                    :onClick="() => copy(draft.markdown)">Copy Markdown</p-button>
                            </div>
                            <p
                                v-if="draft.seo"
                                class="plus-ai-muted">"Apply everything" replaces the content and fills the title, SEO fields and tags.</p>
                            <p
                                v-if="!adapter.canInsert"
                                class="plus-ai-muted">The block editor does not support inserting – "Apply everything" fills the title, SEO and tags; copy the text with "Copy Markdown".</p>
                        </div>
                    </div>

                    <!-- Rewrite selection -->
                    <div v-if="activeTab === 'rewrite'">
                        <template v-if="adapter.canInsert">
                            <p class="plus-ai-muted">Select text in the editor, then choose an action.</p>
                            <select v-model="rewriteAction">
                                <option value="improve">Improve</option>
                                <option value="shorten">Shorten</option>
                                <option value="expand">Expand</option>
                                <option value="simplify">Simplify</option>
                                <option value="fix">Fix grammar and spelling</option>
                                <option value="custom">Custom instruction…</option>
                            </select>
                            <textarea
                                v-if="rewriteAction === 'custom'"
                                v-model="rewriteInstruction"
                                rows="2"
                                placeholder="e.g. Turn this into a bulleted list"></textarea>
                            <p-button
                                :loading="busy === 'rewrite'"
                                :disabled="!!busy"
                                :onClick="runRewrite">Rewrite selection</p-button>

                            <div
                                v-if="rewrite"
                                class="plus-ai-result">
                                <div
                                    class="plus-ai-preview"
                                    v-html="rewritePreview"></div>
                                <div class="plus-ai-buttons">
                                    <p-button :onClick="applyRewrite">Replace selection</p-button>
                                    <p-button
                                        appearance="outline"
                                        :onClick="() => { rewrite = null; }">Discard</p-button>
                                </div>
                            </div>
                        </template>
                        <p
                            v-else
                            class="plus-ai-muted">Not available in the block editor.</p>
                    </div>

                    <div
                        v-if="busy"
                        class="plus-ai-status">
                        Working… <button
                            type="button"
                            class="plus-ai-link"
                            @click="cancel">Cancel</button>
                    </div>
                    <div
                        v-if="error"
                        class="msg msg-small msg-alert plus-ai-error">{{ error }}</div>
                    <p
                        v-if="lastUsage"
                        class="plus-ai-muted plus-ai-usage">{{ lastUsage }}</p>
                </template>
            </div>
        </div>
    </div>
</template>

<script>
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { call, newRequestId } from './api';
import { createEditorAdapter, mergeTags } from './editor-adapter';

export default {
    name: 'plus-ai-panel',
    props: ['context'],
    data () {
        return {
            open: false,
            providersLoaded: false,
            providers: [],
            providerId: '',
            activeTab: 'seo',
            tabs: [
                { id: 'seo', label: 'SEO' },
                { id: 'tags', label: 'Tags' },
                { id: 'write', label: 'Write' },
                { id: 'rewrite', label: 'Rewrite' }
            ],
            busy: '',
            requestId: '',
            error: '',
            lastUsage: '',
            seo: null,
            tagSuggestions: null,
            brief: '',
            draftLength: 'medium',
            fullPost: true,
            tone: '',
            draft: null,
            rewriteAction: 'improve',
            rewriteInstruction: '',
            rewrite: null
        };
    },
    computed: {
        adapter () {
            return createEditorAdapter(this.context);
        },
        postData () {
            return this.context ? this.context.postData : {};
        },
        site () {
            return this.$store.state.currentSite || {};
        },
        seoRows () {
            return [
                { key: 'metaTitle', label: 'Meta title', limit: 70, current: this.postData.metaTitle },
                { key: 'metaDescription', label: 'Meta description', limit: 160, current: this.postData.metaDescription },
                { key: 'slug', label: 'Slug', limit: 0, current: this.postData.slug }
            ];
        },
        draftPreview () {
            return this.draft ? DOMPurify.sanitize(this.draft.html) : '';
        },
        rewritePreview () {
            if (!this.rewrite) return '';
            return this.adapter.format === 'html'
                ? DOMPurify.sanitize(this.rewrite.text)
                : DOMPurify.sanitize(marked.parse(this.rewrite.text, { mangle: false, headerIds: false }));
        }
    },
    watch: {
        open (value) {
            if (value && !this.providersLoaded) this.loadProviders();
        }
    },
    methods: {
        async loadProviders () {
            try {
                const data = await call(this, 'providers:list');
                this.providers = data.providers;
                this.providerId = data.defaultProviderId || (data.providers[0] && data.providers[0].id) || '';
            } catch (e) {
                this.error = e.message;
            } finally {
                this.providersLoaded = true;
            }
        },
        openSettings () {
            this.$router.push('/app-settings');
        },
        shorten (text) {
            const value = String(text || '');
            return value.length > 40 ? value.slice(0, 40) + '…' : value;
        },
        async run (task, input) {
            this.error = '';
            this.busy = task;
            this.requestId = newRequestId();

            try {
                const siteName = this.site.config ? this.site.config.name : '';
                const out = await call(this, 'run', { task, input: { siteName, ...input }, providerId: this.providerId, requestId: this.requestId });
                this.lastUsage = `${out.provider} · ${out.model} · ${out.usage.input}+${out.usage.output} tokens · ${(out.ms / 1000).toFixed(1)} s`;
                return out.result;
            } catch (e) {
                this.error = e.message;
                return null;
            } finally {
                this.busy = '';
                this.requestId = '';
            }
        },
        cancel () {
            if (this.requestId) call(this, 'cancel', this.requestId).catch(() => {});
        },
        baseInput () {
            return { title: this.postData.title, text: this.adapter.getText() };
        },
        async runSeo () {
            const result = await this.run('seo', { ...this.baseInput(), websiteName: this.site.config ? this.site.config.displayName : '' });

            if (result) this.seo = result;
        },
        applySeo (key, values = this.seo, quiet = false) {
            const keys = key ? [key] : ['metaTitle', 'metaDescription', 'slug'];

            for (const k of keys) {
                if (!values[k]) continue;

                this.postData[k] = values[k];

                if (k === 'slug' && 'postSlugEdited' in this.context) {
                    this.context.postSlugEdited = true;
                }
            }

            if (!quiet) this.$bus.$emit('message-display', { message: 'SEO fields updated – remember to save the post.', type: 'success', lifeTime: 3 });
        },
        async runTags () {
            const existingTags = (this.site.tags || []).map(t => t.name);
            const result = await this.run('tags', { ...this.baseInput(), existingTags });

            if (result) {
                const onPost = new Set((this.postData.tags || []).map(t => String(t).toLowerCase()));
                result.tags = result.tags.map(t => ({ ...t, selected: !onPost.has(t.name.toLowerCase()) }));
                this.tagSuggestions = result;
            }
        },
        applyTags (suggestions = this.tagSuggestions, onlySelected = true, quiet = false) {
            const names = suggestions.tags.filter(t => !onlySelected || t.selected).map(t => t.name);
            this.postData.tags = mergeTags(this.postData.tags, names);

            const main = (this.site.tags || []).find(t => t.name === suggestions.mainTag);

            if (main && !this.postData.mainTag && this.context.itemType !== 'page') {
                this.postData.mainTag = main.id;
            }

            if (!quiet) this.$bus.$emit('message-display', { message: `${names.length} tag(s) added.`, type: 'success', lifeTime: 3 });
        },
        async runDraft () {
            const task = this.fullPost ? 'post' : 'draft';
            const result = await this.run(task, {
                brief: this.brief,
                title: this.postData.title,
                text: this.adapter.getText(),
                length: this.draftLength,
                tone: this.tone,
                language: this.site.config ? this.site.config.language : '',
                existingTags: (this.site.tags || []).map(t => t.name)
            });

            if (result) this.draft = result;
        },
        applyEverything () {
            const d = this.draft;

            if (this.adapter.canInsert) {
                const value = this.adapter.format === 'html' ? DOMPurify.sanitize(d.html) : d.markdown;

                if (!this.adapter.replaceAll(value)) {
                    this.error = 'The editor is not ready.';
                    return;
                }
            }

            this.useTitle();
            this.applySeo(null, d.seo, true);
            this.applyTags({ tags: d.tags, mainTag: d.mainTag }, false, true);
            this.$bus.$emit('message-display', { message: 'Content, title, SEO fields and tags updated – remember to save the post.', type: 'success', lifeTime: 4 });
        },
        insertDraft (replace) {
            const value = this.adapter.format === 'html' ? DOMPurify.sanitize(this.draft.html) : this.draft.markdown;
            const ok = replace ? this.adapter.replaceAll(value) : this.adapter.insert(value);

            if (!ok) this.error = 'The editor is not ready.';
            else if (!this.postData.title) this.useTitle();
        },
        useTitle () {
            const title = this.draft.title;
            this.postData.title = title;

            // The title field is a contenteditable filled only on load – update it too
            const field = this.context.$refs && this.context.$refs['post-title'];

            if (field) field.innerText = title;
            if (this.adapter.kind === 'blockeditor') this.$bus.$emit('block-editor-set-post-title', title);
        },
        async runRewrite () {
            const selection = this.adapter.getSelection();

            if (!selection) {
                this.error = 'Select some text in the editor first.';
                return;
            }

            const result = await this.run('rewrite', {
                text: selection.text,
                format: this.adapter.format,
                action: this.rewriteAction,
                instruction: this.rewriteInstruction
            });

            if (result) this.rewrite = { ...result, selection };
        },
        applyRewrite () {
            const value = this.adapter.format === 'html' ? DOMPurify.sanitize(this.rewrite.text) : this.rewrite.text;

            if (!this.adapter.replaceSelection(this.rewrite.selection, value)) this.error = 'The editor is not ready.';
            else this.rewrite = null;
        },
        copy (text) {
            navigator.clipboard.writeText(text).then(() => {
                this.$bus.$emit('message-display', { message: 'Copied to clipboard.', type: 'success', lifeTime: 2 });
            });
        }
    }
};
</script>

<style>
.plus-ai textarea,
.plus-ai select,
.plus-ai input[type="text"] {
    box-sizing: border-box;
    margin: var(--space-1) 0 var(--space-2);
    width: 100%;
}

.plus-ai-provider {
    display: block;
    margin-bottom: var(--space-3);
}

.plus-ai-tabs {
    display: flex;
    gap: var(--space-1);
    margin-bottom: var(--space-3);
}

.plus-ai-tabs button {
    background: none;
    border: 1px solid var(--color-border-default);
    border-radius: var(--radius-base);
    color: inherit;
    cursor: pointer;
    flex: 1;
    font: inherit;
    font-size: var(--font-size-ui-sm);
    padding: var(--space-1) 0;
}

.plus-ai-tabs button.is-active {
    border-color: var(--color-primary);
    color: var(--color-primary);
    font-weight: var(--font-weight-semibold);
}

.plus-ai-muted {
    color: var(--color-text-muted);
    font-size: var(--font-size-ui-sm);
}

.plus-ai-result {
    margin-top: var(--space-4);
}

.plus-ai-row {
    margin-bottom: var(--space-3);
}

.plus-ai-row-head,
.plus-ai-row-buttons {
    align-items: center;
    display: flex;
    gap: var(--space-3);
    justify-content: space-between;
}

.plus-ai-row-buttons {
    flex-wrap: wrap;
    justify-content: flex-end;
}

.plus-ai-count {
    font-size: var(--font-size-ui-xs);
}

.plus-ai-count.is-over {
    color: var(--color-danger);
    font-weight: var(--font-weight-semibold);
}

.plus-ai-link {
    background: none;
    border: none;
    color: var(--color-primary);
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-ui-sm);
    padding: 0;
}

.plus-ai-tag {
    display: block;
    margin: var(--space-1) 0;
}

.plus-ai-new {
    background: var(--color-surface-notice);
    border-radius: var(--radius-base);
    font-size: var(--font-size-ui-xs);
    padding: 0 4px;
}

.plus-ai-check {
    display: block;
    margin-bottom: var(--space-2);
}

.plus-ai-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin: var(--space-2) 0;
}

.plus-ai-summary {
    font-size: var(--font-size-ui-sm);
    margin: var(--space-2) 0;
}

.plus-ai-summary dt {
    font-weight: var(--font-weight-semibold);
    margin-top: var(--space-2);
}

.plus-ai-summary dd {
    margin: 0;
    word-break: break-word;
}

.plus-ai-chip {
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-base);
    display: inline-block;
    margin: 0 var(--space-1) var(--space-1) 0;
    padding: 0 var(--space-1);
}

.plus-ai-inline {
    display: flex;
    gap: var(--space-2);
}

.plus-ai-preview {
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-base);
    font-size: var(--font-size-ui-sm);
    margin: var(--space-2) 0;
    max-height: 260px;
    overflow: auto;
    padding: var(--space-2) var(--space-3);
}

.plus-ai-status,
.plus-ai-error {
    margin-top: var(--space-3);
}

.plus-ai-usage {
    margin-top: var(--space-3);
    word-break: break-word;
}
</style>
