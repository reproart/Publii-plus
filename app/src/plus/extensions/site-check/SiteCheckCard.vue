<template>
    <div class="plus-check-card">
        <div>
            <strong>Site check</strong>
            <span class="plus-check-card-muted">
                Publii Plus · broken links, images, SEO and page weight of what will be published.
                <template v-if="summary"> Last check {{ ago(summary.at) }}: {{ countsText(summary.counts) }}.</template>
            </span>
        </div>
        <p-button
            appearance="outline"
            :onClick="() => { open = true; }">Open site check</p-button>

        <plus-site-check
            v-if="open"
            @close="closed" />
    </div>
</template>

<script>
import SiteCheck from './SiteCheck.vue';
import { ago, countsText } from './labels.js';

export default {
    name: 'plus-site-check-card',
    components: { 'plus-site-check': SiteCheck },
    data () {
        return { open: false, summary: null };
    },
    computed: {
        site () {
            const s = this.$store.state.currentSite;
            return s && s.config ? s.config.name : '';
        }
    },
    mounted () {
        this.load();
    },
    methods: {
        ago,
        countsText,
        async load () {
            this.summary = await this.$plus.invoke('site-check', 'summary', this.site).catch(() => null);
        },
        closed () {
            this.open = false;
            this.load();
        }
    }
};
</script>

<style>
.plus-check-card {
    align-items: center;
    background: var(--bg-secondary);
    border-radius: var(--radius-base);
    display: flex;
    gap: var(--space-4);
    justify-content: space-between;
    margin-top: var(--space-6);
    padding: var(--space-4);
}

.plus-check-card-muted {
    color: var(--color-text-muted);
    display: block;
    font-size: var(--font-size-ui-sm);
}
</style>
