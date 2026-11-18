<template>
    <fields-group title="AI providers (Publii Plus)">
        <p class="plus-ai-intro">
            AI Assistant in the post editor works with OpenAI or any OpenAI-compatible API over http/https
            (OpenRouter, Ollama, LM Studio, vLLM, your own server…). API keys are stored in the system keychain.
        </p>

        <div
            v-if="loadError"
            class="msg msg-small msg-alert">{{ loadError }}</div>

        <table
            v-if="providers.length"
            class="plus-ai-providers">
            <thead>
                <tr>
                    <th>Name</th>
                    <th>Model</th>
                    <th>Endpoint</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>
                <tr
                    v-for="provider in providers"
                    :key="provider.id">
                    <td>
                        <strong>{{ provider.name }}</strong>
                        <span
                            v-if="provider.id === defaultProviderId"
                            class="plus-ai-badge">default</span>
                    </td>
                    <td>{{ provider.model }}</td>
                    <td class="plus-ai-endpoint">
                        {{ provider.baseUrl }}
                        <span
                            v-if="provider.insecure"
                            class="plus-ai-warning"
                            title="The API key is sent over unencrypted http">insecure http</span>
                        <span
                            v-if="provider.authHeader && !provider.hasApiKey"
                            class="plus-ai-warning">no API key</span>
                    </td>
                    <td class="plus-ai-actions">
                        <p-button
                            v-if="provider.id !== defaultProviderId"
                            appearance="clean"
                            :onClick="() => setDefault(provider.id)">Make default</p-button>
                        <p-button
                            appearance="clean"
                            :onClick="() => edit(provider)">Edit</p-button>
                        <p-button
                            appearance="clean"
                            :onClick="() => remove(provider)">Delete</p-button>
                    </td>
                </tr>
            </tbody>
        </table>

        <p-button
            v-if="!form"
            appearance="outline"
            :onClick="add">Add AI provider</p-button>

        <div
            v-if="form"
            class="plus-ai-form">
            <field
                v-if="!form.id"
                id="plus-ai-preset"
                label="Start from">
                <dropdown
                    slot="field"
                    id="plus-ai-preset"
                    :items="presetItems"
                    v-model="presetKey"
                    :onChange="applyPreset"></dropdown>
            </field>

            <field
                id="plus-ai-name"
                label="Name">
                <text-input
                    slot="field"
                    id="plus-ai-name"
                    v-model="form.name"
                    :spellcheck="false" />
            </field>

            <field
                id="plus-ai-type"
                label="API type">
                <dropdown
                    slot="field"
                    id="plus-ai-type"
                    :items="protocolItems"
                    v-model="form.type"></dropdown>
                <small
                    slot="note"
                    class="note">
                    "Chat Completions" works with almost every OpenAI-compatible server.
                </small>
            </field>

            <field
                id="plus-ai-url"
                label="Base URL">
                <text-input
                    slot="field"
                    id="plus-ai-url"
                    v-model="form.baseUrl"
                    placeholder="https://api.example.com/v1"
                    :spellcheck="false" />
                <small
                    slot="note"
                    class="note">
                    The URL before <code>/chat/completions</code> or <code>/responses</code>.
                    <strong v-if="insecureForm"> Warning: with http:// the API key travels unencrypted.</strong>
                </small>
            </field>

            <field
                id="plus-ai-key"
                label="API key">
                <text-input
                    slot="field"
                    id="plus-ai-key"
                    type="password"
                    v-model="form.apiKey"
                    :placeholder="form.hasApiKey ? 'Saved – leave empty to keep' : 'Optional for local servers'"
                    :spellcheck="false" />
                <small
                    v-if="form.hasApiKey"
                    slot="note"
                    class="note">
                    <label><input
                        type="checkbox"
                        v-model="form.removeKey"> Remove the saved key</label>
                </small>
            </field>

            <field
                id="plus-ai-model"
                label="Model">
                <div
                    slot="field"
                    class="plus-ai-model">
                    <text-input
                        id="plus-ai-model"
                        v-model="form.model"
                        placeholder="Model name"
                        :spellcheck="false" />
                    <p-button
                        appearance="outline"
                        :loading="loadingModels"
                        :onClick="loadModels">Load models</p-button>
                </div>
                <small
                    v-if="models.length"
                    slot="note"
                    class="note">
                    <select
                        class="plus-ai-model-list"
                        @change="form.model = $event.target.value">
                        <option value="">Choose from {{ models.length }} models…</option>
                        <option
                            v-for="model in models"
                            :key="model"
                            :value="model">{{ model }}</option>
                    </select>
                </small>
            </field>

            <details class="plus-ai-advanced">
                <summary>Advanced</summary>

                <field
                    id="plus-ai-auth-header"
                    label="Auth header">
                    <div
                        slot="field"
                        class="plus-ai-model">
                        <text-input
                            id="plus-ai-auth-header"
                            v-model="form.authHeader"
                            placeholder="Authorization (empty = none)"
                            :spellcheck="false" />
                        <text-input
                            id="plus-ai-auth-prefix"
                            v-model="form.authPrefix"
                            placeholder="Prefix, e.g. Bearer"
                            :spellcheck="false" />
                    </div>
                </field>

                <field
                    id="plus-ai-headers"
                    label="Extra headers">
                    <textarea
                        slot="field"
                        id="plus-ai-headers"
                        class="plus-ai-textarea"
                        rows="3"
                        spellcheck="false"
                        placeholder="X-Title: My site"
                        v-model="form.headersText"></textarea>
                    <small
                        slot="note"
                        class="note">One "Name: value" per line. Do not put secrets here – use the API key field.</small>
                </field>

                <field
                    id="plus-ai-structured"
                    label="Structured output">
                    <dropdown
                        slot="field"
                        id="plus-ai-structured"
                        :items="structuredItems"
                        v-model="form.structuredOutput"></dropdown>
                    <small
                        slot="note"
                        class="note">Falls back to "JSON via prompt" automatically when the server rejects JSON schema.</small>
                </field>

                <field
                    id="plus-ai-temperature"
                    label="Temperature / limits">
                    <div
                        slot="field"
                        class="plus-ai-model">
                        <text-input
                            id="plus-ai-temperature"
                            v-model="form.temperature"
                            placeholder="Temperature (default)" />
                        <text-input
                            id="plus-ai-max-tokens"
                            v-model="form.maxOutputTokens"
                            placeholder="Max output tokens (default)" />
                        <text-input
                            id="plus-ai-timeout"
                            v-model="form.timeoutSeconds"
                            placeholder="Timeout, s (120)" />
                    </div>
                </field>
            </details>

            <div
                v-if="formMessage"
                :class="['msg', 'msg-small', formMessage.ok ? 'msg-info' : 'msg-alert']">{{ formMessage.text }}</div>

            <div class="plus-ai-form-buttons">
                <p-button
                    :loading="saving"
                    :onClick="save">Save provider</p-button>
                <p-button
                    appearance="outline"
                    :loading="testing"
                    :onClick="test">Test connection</p-button>
                <p-button
                    appearance="clean"
                    :onClick="cancel">Cancel</p-button>
            </div>
        </div>
        <div class="plus-ai-instructions">
            <h3 class="plus-ai-subtitle">Instructions for AI</h3>
            <p class="plus-ai-intro">
                Added to every AI request after the built-in rules: style, audience, words to avoid, and the typography
                your theme supports beyond its editor styles. The editor styles declared by the theme (below) are passed
                automatically; the AI uses HTML in drafts only for those styles and where these instructions allow it.
            </p>

            <field
                id="plus-ai-instructions-global"
                label="For all websites">
                <textarea
                    slot="field"
                    id="plus-ai-instructions-global"
                    class="plus-ai-textarea"
                    rows="5"
                    v-model="instructions.global"
                    placeholder="e.g. Write for beginners. Short paragraphs. No clichés like &quot;in today's fast-paced world&quot;."></textarea>
            </field>

            <field
                v-if="siteName"
                id="plus-ai-instructions-site"
                :label="'Only for ' + siteDisplayName">
                <textarea
                    slot="field"
                    id="plus-ai-instructions-site"
                    class="plus-ai-textarea"
                    rows="5"
                    v-model="instructions.site"
                    placeholder="e.g. Audience: photography beginners. End every post with a link to our newsletter. Use the theme's Warning box for safety notes."></textarea>
                <small
                    slot="note"
                    class="note">Use it for things that depend on this website's theme or audience.</small>
            </field>

            <field
                id="plus-ai-theme-styles"
                label="Theme styles">
                <label
                    slot="field"
                    class="plus-ai-check">
                    <input
                        id="plus-ai-theme-styles"
                        type="checkbox"
                        v-model="instructions.useThemeStyles">
                    Tell the AI which formatting styles the website's theme provides
                </label>
                <small
                    slot="note"
                    class="note">
                    <template v-if="themeStyles.length">
                        {{ siteDisplayName }}: <span
                            v-for="style in themeStyles"
                            :key="style.tag + style.classes"
                            class="plus-ai-style"
                            :title="'<' + style.tag + ' class=&quot;' + style.classes + '&quot;>'">{{ style.label }}</span>
                    </template>
                    <template v-else>The theme of the current website declares no editor styles.</template>
                </small>
            </field>

            <div class="plus-ai-form-buttons">
                <p-button
                    :loading="savingInstructions"
                    :onClick="saveInstructions">Save instructions</p-button>
            </div>
        </div>
    </fields-group>
</template>

<script>
import { call, headersToText, textToHeaders } from './api';
import { currentThemeStyles } from './theme-styles';

export default {
    name: 'plus-ai-settings',
    props: ['context'],
    data () {
        return {
            providers: [],
            defaultProviderId: '',
            presets: [],
            protocols: [],
            loadError: '',
            form: null,
            presetKey: 'openai',
            models: [],
            loadingModels: false,
            saving: false,
            testing: false,
            formMessage: null,
            instructions: { global: '', site: '', useThemeStyles: true },
            savingInstructions: false
        };
    },
    computed: {
        siteName () {
            const site = this.$store.state.currentSite;
            return site && site.config && site.config.name && site.config.name !== '!' ? site.config.name : '';
        },
        themeStyles () {
            return currentThemeStyles(this.$store);
        },
        siteDisplayName () {
            const config = this.$store.state.currentSite.config;
            return config.displayName || config.name;
        },
        presetItems () {
            return this.presets.map(p => ({ value: p.key, label: p.name }));
        },
        protocolItems () {
            return this.protocols;
        },
        structuredItems () {
            return [
                { value: 'json_schema', label: 'JSON schema (recommended)' },
                { value: 'json_object', label: 'JSON mode' },
                { value: 'prompt', label: 'JSON via prompt (any model)' }
            ];
        },
        insecureForm () {
            try {
                const url = new URL(this.form.baseUrl);
                return url.protocol === 'http:' && !/^(localhost|127\.|\[::1\]|10\.|192\.168\.)/.test(url.host) && !!this.form.authHeader;
            } catch (e) {
                return false;
            }
        }
    },
    async mounted () {
        try {
            const meta = await call(this, 'presets');
            this.presets = meta.presets;
            this.protocols = meta.protocols;
            await this.refresh();
            this.instructions = await call(this, 'instructions:get', this.siteName);
        } catch (e) {
            this.loadError = e.message;
        }
    },
    methods: {
        async saveInstructions () {
            this.savingInstructions = true;

            try {
                this.instructions = await call(this, 'instructions:save', { global: this.instructions.global, siteName: this.siteName, site: this.instructions.site, useThemeStyles: this.instructions.useThemeStyles });
                this.$bus.$emit('message-display', { message: 'AI instructions saved.', type: 'success', lifeTime: 3 });
            } catch (e) {
                this.$bus.$emit('message-display', { message: e.message, type: 'warning', lifeTime: 5 });
            } finally {
                this.savingInstructions = false;
            }
        },
        async refresh () {
            const data = await call(this, 'providers:list');
            this.providers = data.providers;
            this.defaultProviderId = data.defaultProviderId;
        },
        blankForm (preset) {
            return {
                id: '',
                name: preset.name,
                type: preset.type,
                baseUrl: preset.baseUrl,
                model: '',
                apiKey: '',
                hasApiKey: false,
                removeKey: false,
                authHeader: preset.authHeader,
                authPrefix: (preset.authPrefix || '').trim(),
                headersText: headersToText(preset.headers),
                structuredOutput: preset.structuredOutput,
                temperature: '',
                maxOutputTokens: '',
                timeoutSeconds: ''
            };
        },
        add () {
            this.presetKey = 'openai';
            this.form = this.blankForm(this.presets.find(p => p.key === 'openai') || this.presets[0]);
            this.models = [];
            this.formMessage = null;
        },
        applyPreset (key) {
            const preset = this.presets.find(p => p.key === key);

            if (preset && this.form && !this.form.id) {
                const keep = { apiKey: this.form.apiKey, model: this.form.model };
                this.form = { ...this.blankForm(preset), ...keep };
                this.models = [];
            }
        },
        edit (provider) {
            this.form = {
                ...this.blankForm(provider),
                id: provider.id,
                name: provider.name,
                model: provider.model,
                hasApiKey: provider.hasApiKey,
                authPrefix: (provider.authPrefix || '').trim(),
                headersText: headersToText(provider.headers),
                temperature: provider.temperature === null ? '' : String(provider.temperature),
                maxOutputTokens: provider.maxOutputTokens === null ? '' : String(provider.maxOutputTokens),
                timeoutSeconds: String(Math.round((provider.timeoutMs || 120000) / 1000))
            };
            this.models = [];
            this.formMessage = null;
        },
        cancel () {
            this.form = null;
        },
        draft () {
            const f = this.form;
            const draft = {
                id: f.id || undefined,
                name: f.name,
                type: f.type,
                baseUrl: f.baseUrl,
                model: f.model,
                authHeader: f.authHeader.trim(),
                authPrefix: f.authPrefix.trim() ? f.authPrefix.trim() + ' ' : '',
                headers: textToHeaders(f.headersText),
                structuredOutput: f.structuredOutput,
                temperature: f.temperature,
                maxOutputTokens: f.maxOutputTokens,
                timeoutSeconds: f.timeoutSeconds
            };

            if (f.apiKey.trim()) draft.apiKey = f.apiKey.trim();
            else if (f.removeKey) draft.apiKey = '';

            return draft;
        },
        async loadModels () {
            this.loadingModels = true;
            this.formMessage = null;

            try {
                this.models = await call(this, 'providers:models', this.draft());

                if (!this.models.length) this.formMessage = { ok: false, text: 'The server returned no models – enter the model name manually.' };
            } catch (e) {
                this.formMessage = { ok: false, text: 'Cannot load models: ' + e.message };
            } finally {
                this.loadingModels = false;
            }
        },
        async test () {
            this.testing = true;
            this.formMessage = null;

            try {
                const out = await call(this, 'providers:test', this.draft());
                this.formMessage = out.ok
                    ? { ok: true, text: `Connection works: ${out.model} answered in ${(out.ms / 1000).toFixed(1)} s.` }
                    : { ok: false, text: 'The model answered, but not as expected.' };
            } catch (e) {
                this.formMessage = { ok: false, text: e.message };
            } finally {
                this.testing = false;
            }
        },
        async save () {
            this.saving = true;
            this.formMessage = null;

            try {
                await call(this, 'providers:save', this.draft());
                this.form = null;
                await this.refresh();
                this.$bus.$emit('message-display', { message: 'AI provider saved.', type: 'success', lifeTime: 3 });
            } catch (e) {
                this.formMessage = { ok: false, text: e.message };
            } finally {
                this.saving = false;
            }
        },
        async setDefault (id) {
            await call(this, 'providers:set-default', id);
            await this.refresh();
        },
        async remove (provider) {
            if (!window.confirm(`Delete the AI provider "${provider.name}" and its saved API key?`)) {
                return;
            }

            await call(this, 'providers:remove', provider.id);
            await this.refresh();
        }
    }
};
</script>

<style>
.plus-ai-instructions {
    border-top: 1px solid var(--color-border-subtle);
    margin-top: var(--space-6);
    padding-top: var(--space-4);
}

.plus-ai-check {
    display: block;
}

.plus-ai-style {
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-base);
    display: inline-block;
    font-style: normal;
    margin: 0 var(--space-1) var(--space-1) 0;
    padding: 0 var(--space-1);
}

.plus-ai-subtitle {
    font-size: var(--font-size-ui-md);
    font-weight: var(--font-weight-semibold);
    margin: 0 0 var(--space-2);
}

.plus-ai-intro {
    margin-top: 0;
}

.plus-ai-providers {
    border-collapse: collapse;
    margin-bottom: var(--space-4);
    width: 100%;
}

.plus-ai-providers th,
.plus-ai-providers td {
    border-bottom: 1px solid var(--color-border-subtle);
    padding: var(--space-2) var(--space-2) var(--space-2) 0;
    text-align: left;
    vertical-align: middle;
}

.plus-ai-endpoint {
    font-size: var(--font-size-ui-sm);
    word-break: break-all;
}

.plus-ai-actions {
    text-align: right !important;
    white-space: nowrap;
}

.plus-ai-badge,
.plus-ai-warning {
    border-radius: var(--radius-base);
    font-size: var(--font-size-ui-xs);
    margin-left: var(--space-1);
    padding: 1px 6px;
}

.plus-ai-badge {
    background: var(--color-highlight-surface);
}

.plus-ai-warning {
    background: var(--color-surface-notice);
}

.plus-ai-form {
    border-top: 1px solid var(--color-border-subtle);
    margin-top: var(--space-4);
    padding-top: var(--space-4);
}

.plus-ai-model {
    display: flex;
    gap: var(--space-2);
}

.plus-ai-model-list,
.plus-ai-textarea {
    width: 100%;
}

.plus-ai-advanced summary {
    cursor: pointer;
    margin: var(--space-4) 0;
}

.plus-ai-form-buttons {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-4);
}
</style>
