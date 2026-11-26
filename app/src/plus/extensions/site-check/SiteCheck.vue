<template>
    <div
        class="plus-check"
        role="dialog"
        aria-label="Site check">
        <header class="plus-check-header">
            <div class="plus-check-title">
                <strong>Site check</strong>
                <span class="plus-check-muted">{{ site }} · what will be published: links, images, SEO, page weight</span>
            </div>
            <div class="plus-check-actions">
                <label class="plus-check-option">
                    <input
                        v-model="external"
                        type="checkbox"
                        :disabled="running"> External links
                </label>
                <p-button
                    v-if="!running"
                    :onClick="() => run(true)">Check site</p-button>
                <p-button
                    v-if="!running && report"
                    appearance="outline"
                    title="Check the last rendered version without rendering again"
                    :onClick="() => run(false)">Check last render</p-button>
                <p-button
                    v-if="running"
                    appearance="outline"
                    :onClick="cancel">Cancel</p-button>
                <p-button
                    v-if="report && !running"
                    appearance="clean"
                    :onClick="copy">{{ copied ? 'Copied' : 'Copy report' }}</p-button>
                <p-button
                    appearance="clean"
                    :onClick="() => $emit('close')">Close</p-button>
            </div>
        </header>

        <div class="plus-check-body">
            <div
                v-if="running"
                class="plus-check-progress"
                role="status">
                <span class="plus-check-spinner" aria-hidden="true" />
                {{ progressText }}
            </div>

            <div
                v-if="error"
                class="msg msg-small msg-alert">{{ error }}</div>

            <div
                v-if="!report && !running && !error"
                class="plus-check-empty">
                <p><strong>The website has not been checked yet.</strong></p>
                <p class="plus-check-muted">
                    "Check site" renders the website exactly like Sync and checks every page: broken links and missing files,
                    links to missing sections, images without alt text, heavy images and pages, titles, meta descriptions,
                    headings, indexing (noindex, robots.txt, canonical) and insecure resources. With "External links" every
                    link to other websites is opened as well (takes longer). Nothing is published.
                </p>
            </div>

            <template v-if="report">
                <div class="plus-check-summary">
                    <span class="plus-check-muted">
                        {{ ago(report.at) }} · {{ report.pages }} pages
                        <template v-if="report.external.checked"> · {{ report.external.total }} external links checked</template>
                        <template v-else-if="report.external.total"> · {{ report.external.total }} external links not checked</template>
                        <template v-if="!report.rendered"> · last render</template>
                    </span>
                    <div class="plus-check-filters">
                        <button
                            v-for="(info, sev) in severities"
                            :key="sev"
                            type="button"
                            :class="['plus-check-chip', 'is-' + sev, { 'is-off': !shown[sev] }]"
                            :aria-pressed="shown[sev] ? 'true' : 'false'"
                            @click="shown[sev] = !shown[sev]">{{ report.counts[sev] }} {{ report.counts[sev] === 1 ? info.one : info.label.toLowerCase() }}</button>
                        <input
                            v-model="query"
                            class="plus-check-search"
                            type="search"
                            placeholder="Filter by page or link"
                            aria-label="Filter by page or link">
                    </div>
                </div>

                <p
                    v-if="!report.issues.length"
                    class="plus-check-ok">✓ No problems found.</p>

                <details
                    v-for="group in groups"
                    :key="group.check"
                    class="plus-check-group"
                    :open="group.severity === 'error' || groups.length <= 4">
                    <summary>
                        <span :class="'plus-check-dot is-' + group.severity" aria-hidden="true" />
                        <strong>{{ group.title }}</strong>
                        <span class="plus-check-count">{{ group.items.length }}</span>
                        <span class="plus-check-muted plus-check-help">{{ group.help }}</span>
                    </summary>
                    <ul class="plus-check-list">
                        <li
                            v-for="(issue, i) in group.items.slice(0, group.limit)"
                            :key="i"
                            class="plus-check-item">
                            <div class="plus-check-where">
                                <a
                                    v-if="issue.page && pageUrl(issue.page)"
                                    href="#"
                                    class="plus-check-page"
                                    title="Open on the website"
                                    @click.prevent="open(pageUrl(issue.page))">{{ issue.item ? issue.item.title : issue.page }}</a>
                                <span
                                    v-else
                                    class="plus-check-page">{{ issue.item ? issue.item.title : (issue.page || 'Whole website') }}</span>
                                <span
                                    v-if="issue.item"
                                    class="plus-check-muted">{{ issue.page }}</span>
                                <p-button
                                    v-if="issue.item"
                                    appearance="outline"
                                    size="small"
                                    :onClick="() => edit(issue.item)">Edit</p-button>
                            </div>
                            <div
                                v-if="issue.target"
                                class="plus-check-target">
                                <a
                                    v-if="/^https?:/.test(issue.target)"
                                    href="#"
                                    @click.prevent="open(issue.target)">{{ issue.target }}</a>
                                <span v-else>{{ issue.target }}</span>
                                <span
                                    v-if="issue.text"
                                    class="plus-check-muted"> – “{{ issue.text }}”</span>
                            </div>
                            <div
                                v-if="issue.detail"
                                class="plus-check-muted">{{ issue.detail }}</div>
                        </li>
                    </ul>
                    <p-button
                        v-if="group.items.length > group.limit"
                        appearance="clean"
                        size="small"
                        :onClick="() => more(group.check)">Show {{ Math.min(100, group.items.length - group.limit) }} more</p-button>
                </details>

                <p
                    v-if="report.truncated"
                    class="plus-check-muted">The report shows the first 3000 results.</p>
            </template>
        </div>
    </div>
</template>

<script>
import { CHECKS, SEVERITY, ago, reportMarkdown } from './labels.js';

const ORDER = { error: 0, warning: 1, notice: 2 };

export default {
    name: 'plus-site-check',
    props: {
        autoRun: { type: Boolean, default: false }
    },
    data () {
        return {
            report: null,
            running: false,
            progress: null,
            error: '',
            external: true,
            shown: { error: true, warning: true, notice: true },
            query: '',
            limits: {},
            copied: false,
            timer: null
        };
    },
    computed: {
        site () {
            const s = this.$store.state.currentSite;
            return s && s.config ? s.config.name : '';
        },
        severities () {
            return SEVERITY;
        },
        groups () {
            if (!this.report) return [];

            const q = this.query.trim().toLowerCase();
            const map = new Map();

            for (const issue of this.report.issues) {
                if (!this.shown[issue.severity]) continue;
                if (q && ![issue.page, issue.target, issue.text, issue.item && issue.item.title].some(v => String(v || '').toLowerCase().includes(q))) continue;

                if (!map.has(issue.check)) {
                    const info = CHECKS[issue.check] || { title: issue.check, help: '' };
                    map.set(issue.check, { check: issue.check, severity: issue.severity, title: info.title, help: info.help, items: [], limit: this.limits[issue.check] || 25 });
                }

                map.get(issue.check).items.push(issue);
            }

            return [...map.values()].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
        },
        progressText () {
            const p = this.progress || {};

            if (p.phase === 'render') return 'Rendering the website (like Sync)…';
            if (p.phase === 'scan') return 'Checking pages…';
            if (p.phase === 'external') return `Checking external links… ${p.done || 0} / ${p.total || 0}`;
            return 'Starting…';
        }
    },
    async mounted () {
        try {
            this.report = await this.$plus.invoke('site-check', 'report', this.site);
        } catch (e) {
            this.report = null;
        }

        const p = await this.$plus.invoke('site-check', 'progress', this.site).catch(() => ({ running: false }));

        if (p.running) this.watch();
        else if (this.autoRun) this.run(true);
    },
    beforeDestroy () {
        clearInterval(this.timer);
    },
    methods: {
        ago,
        watch () {
            this.running = true;
            clearInterval(this.timer);
            this.timer = setInterval(async () => {
                try {
                    this.progress = await this.$plus.invoke('site-check', 'progress', this.site);

                    if (!this.progress.running) {
                        clearInterval(this.timer);
                        this.running = false;
                        this.report = await this.$plus.invoke('site-check', 'report', this.site);
                    }
                } catch (e) {
                    clearInterval(this.timer);
                    this.running = false;
                }
            }, 400);
        },
        async run (rerender) {
            this.error = '';
            this.running = true;
            this.progress = { phase: rerender ? 'render' : 'scan' };
            this.limits = {};

            const poll = setInterval(async () => {
                this.progress = await this.$plus.invoke('site-check', 'progress', this.site).catch(() => this.progress);
            }, 400);

            try {
                this.report = await this.$plus.invoke('site-check', 'run', this.site, { rerender, external: this.external });
                this.$emit('checked', this.report);
            } catch (e) {
                this.error = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
            } finally {
                clearInterval(poll);
                this.running = false;
            }
        },
        cancel () {
            this.$plus.invoke('site-check', 'cancel', this.site);
        },
        more (check) {
            this.$set(this.limits, check, (this.limits[check] || 25) + 100);
        },
        pageUrl (rel) {
            const domain = this.report && this.report.domain;

            if (!/^https?:\/\//.test(domain || '')) return '';
            return domain.replace(/\/+$/, '') + '/' + rel.replace(/(^|\/)index\.html$/, '$1');
        },
        open (url) {
            this.$plus.invoke('site-check', 'open-external', url);
        },
        edit (item) {
            this.$emit('close');
            this.$router.push(`/site/${this.site}/${item.type === 'page' ? 'pages' : 'posts'}/editor/${item.editor}/${item.id}`);
        },
        async copy () {
            try {
                await navigator.clipboard.writeText(reportMarkdown(this.report, this.site));
                this.copied = true;
                setTimeout(() => { this.copied = false; }, 2000);
            } catch (e) {
                this.error = 'Could not copy the report.';
            }
        }
    }
};
</script>

<style>
.plus-check {
    background: var(--bg-primary);
    display: flex;
    flex-direction: column;
    inset: var(--topbar-height) 0 0 0;
    position: fixed;
    z-index: var(--layer-overlay);
}

.plus-check-header {
    align-items: center;
    border-bottom: 1px solid var(--color-border-subtle);
    display: flex;
    gap: var(--space-4);
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
}

.plus-check-title {
    display: flex;
    flex-direction: column;
}

.plus-check-actions,
.plus-check-filters {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
}

.plus-check-option {
    font-size: var(--font-size-ui-sm);
    margin-right: var(--space-2);
}

.plus-check-muted {
    color: var(--color-text-muted);
    font-size: var(--font-size-ui-sm);
}

.plus-check-body {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--space-3);
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-4);
}

.plus-check-empty {
    max-width: 640px;
}

.plus-check-progress {
    align-items: center;
    display: flex;
    font-size: var(--font-size-ui-md);
    gap: var(--space-2);
}

.plus-check-spinner {
    animation: plus-check-spin 0.8s linear infinite;
    border: 2px solid var(--color-border-subtle);
    border-radius: 50%;
    border-top-color: var(--color-primary);
    display: inline-block;
    height: var(--space-4);
    width: var(--space-4);
}

@keyframes plus-check-spin {
    to { transform: rotate(360deg); }
}

.plus-check-summary {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
}

.plus-check-chip {
    background: var(--color-surface-subtle);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-base);
    cursor: pointer;
    font-size: var(--font-size-ui-sm);
    padding: var(--space-1) var(--space-2);
}

.plus-check-chip.is-error {
    border-color: var(--color-danger);
    color: var(--color-danger);
}

.plus-check-chip.is-warning {
    border-color: var(--color-warning);
}

.plus-check-chip.is-off {
    opacity: 0.45;
    text-decoration: line-through;
}

.plus-check-search {
    flex: 1;
    max-width: 320px;
    min-width: 160px;
}

.plus-check-ok {
    color: var(--color-success);
    font-size: var(--font-size-ui-md);
}

.plus-check-group {
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-base);
    padding: var(--space-2) var(--space-3);
}

.plus-check-group summary {
    align-items: baseline;
    cursor: pointer;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
}

.plus-check-dot {
    border-radius: 50%;
    display: inline-block;
    height: var(--space-2);
    width: var(--space-2);
}

.plus-check-dot.is-error {
    background: var(--color-danger);
}

.plus-check-dot.is-warning {
    background: var(--color-warning);
}

.plus-check-dot.is-notice {
    background: var(--color-icon-muted);
}

.plus-check-count {
    background: var(--color-surface-subtle);
    border-radius: var(--radius-base);
    font-size: var(--font-size-ui-xs);
    padding: 0 var(--space-1);
}

.plus-check-help {
    flex-basis: 100%;
}

.plus-check-list {
    list-style: none;
    margin: var(--space-2) 0 0;
    padding: 0;
}

.plus-check-item {
    border-top: 1px solid var(--color-border-subtle);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2) 0;
}

.plus-check-where {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
}

.plus-check-page {
    font-weight: var(--font-weight-semibold);
}

.plus-check-target {
    font-family: var(--font-family-mono);
    font-size: var(--font-size-ui-sm);
    overflow-wrap: anywhere;
}
</style>
