<template>
    <div
        class="plus-alt"
        role="dialog"
        aria-label="AI alt texts">
        <header class="plus-alt-header">
            <div class="plus-alt-title">
                <strong>AI alt texts</strong>
                <span class="plus-alt-muted">{{ site }} · images in posts and pages without a description</span>
            </div>
            <div class="plus-alt-actions">
                <label
                    v-if="providers.length > 1"
                    class="plus-alt-provider">Model
                    <select
                        v-model="providerId"
                        :disabled="generating">
                        <option
                            v-for="p in providers"
                            :key="p.id"
                            :value="p.id">{{ p.name }} · {{ p.model }}</option>
                    </select>
                </label>
                <p-button
                    v-if="!generating"
                    :disabled="!toGenerate.length || !providers.length"
                    :onClick="generateAll">Write {{ toGenerate.length || '' }} alt text{{ toGenerate.length === 1 ? '' : 's' }}</p-button>
                <p-button
                    v-else
                    appearance="outline"
                    :onClick="cancel">Stop ({{ done }} / {{ total }})</p-button>
                <p-button
                    appearance="outline"
                    :disabled="!toApply.length || generating || saving"
                    :onClick="apply">Save {{ toApply.length || '' }}</p-button>
                <p-button
                    appearance="clean"
                    :onClick="close">Close</p-button>
            </div>
        </header>

        <div class="plus-alt-body">
            <div
                v-if="message"
                :class="['msg', 'msg-small', messageKind === 'error' ? 'msg-alert' : 'msg-success']">
                {{ message }}
                <a
                    v-if="undoId"
                    href="#"
                    @click.prevent="undo">Undo</a>
            </div>

            <p
                v-if="loading"
                class="plus-alt-muted">Looking for images…</p>

            <div
                v-else-if="!posts.length"
                class="plus-alt-empty">
                <p><strong>All images have a description.</strong></p>
                <p class="plus-alt-muted">Posts and pages were checked: content images, galleries and featured images.</p>
            </div>

            <template v-else>
                <p class="plus-alt-muted">
                    {{ imageCount }} image(s) in {{ posts.length }} post(s)/page(s). The model looks at each image and the text around it and
                    writes a short description in the site language. Check and edit the texts, then save – nothing changes before that.
                    Images go to the selected AI provider. After saving, use Preview or Sync to publish.
                </p>
                <p
                    v-if="!providers.length"
                    class="msg msg-small msg-alert">Add an AI provider with a model that understands images in Settings → AI providers.</p>

                <section
                    v-for="post in posts"
                    :key="post.postId"
                    class="plus-alt-post">
                    <h3>
                        {{ post.title || '(no title)' }}
                        <span class="plus-alt-badge">{{ post.type === 'page' ? 'Page' : 'Post' }}</span>
                        <span
                            v-if="post.draft"
                            class="plus-alt-badge">Draft</span>
                    </h3>

                    <div
                        v-for="image in post.images"
                        :key="image.id"
                        class="plus-alt-row">
                        <div class="plus-alt-thumb">
                            <img
                                v-if="image.thumb"
                                :src="image.thumb"
                                alt=""
                                loading="lazy">
                        </div>
                        <div class="plus-alt-main">
                            <div class="plus-alt-meta">
                                <span class="plus-alt-badge">{{ kindLabel(image.kind) }}</span>
                                <span class="plus-alt-file">{{ fileName(image.src) }}</span>
                                <span
                                    v-if="image.caption"
                                    class="plus-alt-muted">Caption: {{ image.caption }}</span>
                            </div>

                            <p
                                v-if="!image.describable"
                                class="plus-alt-muted">Cannot be described: {{ image.reason }}.</p>

                            <template v-else>
                                <div class="plus-alt-edit">
                                    <input
                                        v-model="state(post, image).checked"
                                        type="checkbox"
                                        :disabled="!state(post, image).alt.trim()"
                                        :aria-label="'Save the alt text of ' + fileName(image.src)">
                                    <textarea
                                        v-model="state(post, image).alt"
                                        rows="2"
                                        maxlength="250"
                                        :placeholder="state(post, image).busy ? 'Writing…' : 'Alt text'"
                                        :aria-label="'Alt text of ' + fileName(image.src)"
                                        @input="state(post, image).checked = !!state(post, image).alt.trim()" />
                                    <p-button
                                        appearance="clean"
                                        size="small"
                                        :disabled="state(post, image).busy || generating || !providers.length"
                                        :onClick="() => generateOne(post, image)">{{ state(post, image).alt ? 'Again' : 'Write' }}</p-button>
                                </div>
                                <p
                                    v-if="state(post, image).decorative"
                                    class="plus-alt-muted">The model considers this image decorative – an empty alt is fine, or write a text yourself.</p>
                                <p
                                    v-if="state(post, image).error"
                                    class="plus-alt-error">{{ state(post, image).error }}</p>
                                <p class="plus-alt-muted plus-alt-length">{{ state(post, image).alt.length }} / 125</p>
                            </template>
                        </div>
                    </div>
                </section>
            </template>
        </div>
    </div>
</template>

<script>
const CONCURRENCY = 2;

export default {
    name: 'plus-alt-texts',
    props: {
        postIds: { type: Array, default: null }
    },
    data () {
        return {
            loading: true,
            posts: [],
            states: {},
            providers: [],
            providerId: '',
            generating: false,
            stopped: false,
            active: [],
            done: 0,
            total: 0,
            saving: false,
            message: '',
            messageKind: '',
            undoId: null,
            savedAny: false
        };
    },
    computed: {
        site () {
            const s = this.$store.state.currentSite;
            return s && s.config ? s.config.name : '';
        },
        imageCount () {
            return this.posts.reduce((n, p) => n + p.images.length, 0);
        },
        items () {
            return this.posts.flatMap(post => post.images.filter(i => i.describable).map(image => ({ post, image })));
        },
        toGenerate () {
            return this.items.filter(({ post, image }) => !this.state(post, image).alt.trim());
        },
        toApply () {
            return this.items.filter(({ post, image }) => this.state(post, image).checked && this.state(post, image).alt.trim());
        }
    },
    async mounted () {
        try {
            const data = await this.$plus.invoke('ai-assistant', 'providers:list');
            this.providers = data.providers || [];
            this.providerId = data.defaultProviderId || (this.providers[0] && this.providers[0].id) || '';
        } catch (e) {
            this.providers = [];
        }

        await this.scan();
    },
    beforeDestroy () {
        this.cancel();
    },
    methods: {
        key (post, image) {
            return post.postId + ':' + image.id;
        },
        state (post, image) {
            const k = this.key(post, image);

            if (!this.states[k]) this.$set(this.states, k, { alt: '', src: image.src, checked: false, busy: false, error: '', decorative: false });
            return this.states[k];
        },
        kindLabel (kind) {
            return { featured: 'Featured image', gallery: 'Gallery', content: 'Image' }[kind] || 'Image';
        },
        fileName (src) {
            return String(src || '').replace(/^#DOMAIN_NAME#/, '').split(/[?#]/)[0].split('/').pop();
        },
        async scan () {
            this.loading = true;

            try {
                this.posts = await this.$plus.invoke('ai-assistant', 'alt:scan', this.site, { postIds: this.postIds });
            } catch (e) {
                this.show(this.clean(e), 'error');
                this.posts = [];
            } finally {
                this.loading = false;
            }
        },
        clean (e) {
            return String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        },
        show (text, kind = 'success') {
            this.message = text;
            this.messageKind = kind;
        },
        async describe (post, image) {
            const s = this.state(post, image);
            const requestId = `alt-${post.postId}-${image.id}-${Date.now()}`;

            s.busy = true;
            s.error = '';
            this.active.push(requestId);

            try {
                const out = await this.$plus.invoke('ai-assistant', 'alt:describe', this.site, post.postId, image.id, { providerId: this.providerId, requestId });
                s.alt = out.alt;
                s.src = out.src;
                s.decorative = out.decorative;
                s.checked = !!out.alt;
            } catch (e) {
                if (!this.stopped) s.error = this.clean(e);
            } finally {
                s.busy = false;
                this.active = this.active.filter(id => id !== requestId);
                this.done++;
            }
        },
        async generateOne (post, image) {
            this.done = 0;
            this.total = 1;
            await this.describe(post, image);
        },
        async generateAll () {
            const queue = this.toGenerate.slice();

            this.generating = true;
            this.stopped = false;
            this.done = 0;
            this.total = queue.length;
            this.message = '';

            const worker = async () => {
                while (queue.length && !this.stopped) {
                    const { post, image } = queue.shift();
                    await this.describe(post, image);
                }
            };

            await Promise.all(Array.from({ length: CONCURRENCY }, worker));
            this.generating = false;

            const failed = this.items.filter(({ post, image }) => this.state(post, image).error).length;

            if (failed) this.show(`${failed} image(s) could not be described – see the messages below. The model of the provider must understand images.`, 'error');
        },
        cancel () {
            this.stopped = true;
            this.active.forEach(id => this.$plus.invoke('ai-assistant', 'alt:cancel', id).catch(() => {}));
        },
        async apply () {
            const byPost = new Map();

            for (const { post, image } of this.toApply) {
                const s = this.state(post, image);

                if (!byPost.has(post.postId)) byPost.set(post.postId, { postId: post.postId, alts: {}, srcs: {} });

                byPost.get(post.postId).alts[image.id] = s.alt.trim();
                byPost.get(post.postId).srcs[image.id] = s.src;
            }

            this.saving = true;

            try {
                const out = await this.$plus.invoke('ai-assistant', 'alt:apply', this.site, [...byPost.values()]);
                this.undoId = out.undoId;
                this.savedAny = true;
                this.show(`Saved ${out.images} alt text(s) in ${out.posts} post(s)/page(s)` +
                    (out.skipped ? ` (${out.skipped} skipped – the post was changed meanwhile)` : '') + '. Use Preview or Sync to publish.');
                await this.refreshStore();
                this.states = {};
                await this.scan();
            } catch (e) {
                this.show(this.clean(e), 'error');
            } finally {
                this.saving = false;
            }
        },
        async undo () {
            try {
                const out = await this.$plus.invoke('ai-assistant', 'alt:undo', this.undoId);
                this.undoId = null;
                this.show(`Restored ${out.posts} post(s)/page(s).`);
                await this.refreshStore();
                await this.scan();
            } catch (e) {
                this.show(this.clean(e), 'error');
            }
        },
        async refreshStore () {
            try {
                const data = await this.$plus.invoke('ai-assistant', 'agent:store-data', this.site);
                this.$store.commit('refreshAfterPostUpdate', data);
            } catch (e) {
                // the lists refresh the next time the website is opened
            }
        },
        close () {
            this.$emit('close', { saved: this.savedAny });
        }
    }
};
</script>

<style>
.plus-alt {
    background: var(--bg-primary);
    display: flex;
    flex-direction: column;
    inset: var(--topbar-height) 0 0 0;
    position: fixed;
    z-index: var(--layer-overlay);
}

.plus-alt-header {
    align-items: center;
    border-bottom: 1px solid var(--color-border-subtle);
    display: flex;
    gap: var(--space-4);
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
}

.plus-alt-title {
    display: flex;
    flex-direction: column;
}

.plus-alt-actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
}

.plus-alt-provider {
    align-items: center;
    display: flex;
    font-size: var(--font-size-ui-sm);
    gap: var(--space-2);
}

.plus-alt-muted {
    color: var(--color-text-muted);
    font-size: var(--font-size-ui-sm);
    margin: 0;
}

.plus-alt-body {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--space-3);
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-4);
}

.plus-alt-empty {
    max-width: 640px;
}

.plus-alt-post {
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-base);
    padding: var(--space-2) var(--space-3);
}

.plus-alt-post h3 {
    align-items: center;
    display: flex;
    font-size: var(--font-size-ui-md);
    gap: var(--space-2);
    margin: var(--space-1) 0 var(--space-2);
}

.plus-alt-badge {
    background: var(--color-surface-subtle);
    border-radius: var(--radius-base);
    font-size: var(--font-size-ui-xs);
    font-weight: var(--font-weight-regular);
    padding: 0 var(--space-1);
}

.plus-alt-row {
    border-top: 1px solid var(--color-border-subtle);
    display: flex;
    gap: var(--space-3);
    padding: var(--space-2) 0;
}

.plus-alt-thumb {
    background: var(--color-surface-subtle);
    border-radius: var(--radius-base);
    flex: 0 0 auto;
    height: var(--space-16);
    overflow: hidden;
    width: calc(var(--space-16) * 1.33);
}

.plus-alt-thumb img {
    display: block;
    height: 100%;
    object-fit: cover;
    width: 100%;
}

.plus-alt-main {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
}

.plus-alt-meta {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
}

.plus-alt-file {
    font-family: var(--font-family-mono);
    font-size: var(--font-size-ui-sm);
}

.plus-alt-edit {
    align-items: flex-start;
    display: flex;
    gap: var(--space-2);
}

.plus-alt-edit input {
    margin-top: var(--space-2);
}

.plus-alt-edit textarea {
    box-sizing: border-box;
    flex: 1;
    font: inherit;
    font-size: var(--font-size-ui-sm);
    min-height: var(--space-12);
    resize: vertical;
}

.plus-alt-length {
    text-align: right;
}

.plus-alt-error {
    color: var(--color-danger);
    font-size: var(--font-size-ui-sm);
    margin: 0;
}
</style>
