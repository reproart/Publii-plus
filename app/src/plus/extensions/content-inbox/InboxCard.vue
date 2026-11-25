<template>
    <div class="plus-inbox-card">
        <div>
            <strong>Content inbox</strong>
            <span class="plus-inbox-muted">
                Publii Plus · Markdown files from a GitHub folder (or a local folder) become posts, then the website is synced.
                <template v-if="summary"> {{ summary }}</template>
            </span>
        </div>
        <p-button
            appearance="outline"
            :onClick="() => { open = true; }">Open inbox</p-button>

        <plus-content-inbox
            v-if="open"
            @close="closed" />
    </div>
</template>

<script>
import ContentInbox from './ContentInbox.vue';

export default {
    name: 'plus-inbox-card',
    components: { 'plus-content-inbox': ContentInbox },
    data () {
        return { open: false, status: null };
    },
    computed: {
        site () {
            const s = this.$store.state.currentSite;
            return s && s.config ? s.config.name : '';
        },
        summary () {
            if (!this.status) return '';

            const c = this.status.config;
            const on = c.enabled ? `Automatic: every ${c.intervalMinutes} min.` : 'Automatic import is off.';
            return `${on} ${this.status.imported} imported post(s).`;
        }
    },
    mounted () {
        this.load();
    },
    methods: {
        async load () {
            try {
                this.status = await this.$plus.invoke('content-inbox', 'status', this.site);
            } catch (e) {
                this.status = null;
            }
        },
        closed () {
            this.open = false;
            this.load();
        }
    }
};
</script>

<style>
.plus-inbox-card {
    align-items: center;
    background: var(--bg-secondary);
    border-radius: var(--radius-base);
    display: flex;
    gap: var(--space-4);
    justify-content: space-between;
    margin-top: var(--space-6);
    padding: var(--space-4);
}

.plus-inbox-muted {
    color: var(--color-text-muted);
    display: block;
    font-size: var(--font-size-ui-sm);
}
</style>
