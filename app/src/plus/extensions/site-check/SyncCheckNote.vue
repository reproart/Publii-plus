<template>
    <div
        class="plus-sync-check"
        role="status">
        <span
            :class="'plus-sync-check-dot is-' + state"
            aria-hidden="true" />
        <span v-if="!summary">Site check: this website has not been checked yet.</span>
        <span v-else>Site check {{ ago(summary.at) }}: {{ countsText(summary.counts) }}.</span>
        <a
            href="#"
            @click.prevent="open = true">{{ summary ? 'Show report / check again' : 'Check before syncing' }}</a>

        <plus-site-check
            v-if="open"
            :auto-run="!summary"
            @close="closed" />
    </div>
</template>

<script>
import SiteCheck from './SiteCheck.vue';
import { ago, countsText } from './labels.js';

export default {
    name: 'plus-sync-check-note',
    components: { 'plus-site-check': SiteCheck },
    data () {
        return { summary: null, open: false };
    },
    computed: {
        site () {
            const s = this.$store.state.currentSite;
            return s && s.config ? s.config.name : '';
        },
        state () {
            if (!this.summary) return 'none';
            if (this.summary.counts.error) return 'error';
            if (this.summary.counts.warning) return 'warning';
            return 'ok';
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
.plus-sync-check {
    align-items: center;
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-base);
    display: flex;
    flex-wrap: wrap;
    font-size: var(--font-size-ui-sm);
    gap: var(--space-2);
    justify-content: center;
    margin: var(--space-3) auto;
    padding: var(--space-2) var(--space-3);
}

.plus-sync-check-dot {
    border-radius: 50%;
    display: inline-block;
    height: var(--space-2);
    width: var(--space-2);
}

.plus-sync-check-dot.is-error {
    background: var(--color-danger);
}

.plus-sync-check-dot.is-warning {
    background: var(--color-warning);
}

.plus-sync-check-dot.is-ok {
    background: var(--color-success);
}

.plus-sync-check-dot.is-none {
    background: var(--color-icon-muted);
}
</style>
