<template>
    <div class="plus-tr-card">
        <div>
            <strong>Translations</strong>
            <span class="plus-tr-card-muted">
                Publii Plus · published posts are translated with AI into language websites (one Publii website per language).
                <template v-if="summary"> {{ summary }}</template>
            </span>
        </div>
        <p-button
            appearance="outline"
            :onClick="() => { open = true; }">Open translations</p-button>

        <plus-translations
            v-if="open"
            @close="closed" />
    </div>
</template>

<script>
import Translations from './Translations.vue';

export default {
    name: 'plus-translations-card',
    components: { 'plus-translations': Translations },
    data () {
        return { open: false, status: null };
    },
    computed: {
        site () {
            const s = this.$store.state.currentSite;
            return s && s.config ? s.config.name : '';
        },
        summary () {
            const s = this.status;

            if (!s) return '';
            if (s.translationOf) return `This website receives translations from "${s.translationOf}".`;
            if (!s.config.targets.length) return '';

            const targets = s.config.targets.map(t => t.site).join(', ');
            const done = s.items.filter(i => i.state === 'current').length;
            const todo = s.items.filter(i => i.action === 'create' || i.action === 'update').length;
            const auto = s.config.enabled ? `automatic every ${s.config.intervalMinutes} min` : 'automatic translation is off';

            return `Into ${targets} · ${auto} · ${done} up to date${todo ? `, ${todo} to translate` : ''}.`;
        }
    },
    mounted () {
        this.load();
    },
    methods: {
        async load () {
            try {
                this.status = await this.$plus.invoke('translations', 'status', this.site);
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
.plus-tr-card {
    align-items: center;
    background: var(--bg-secondary);
    border-radius: var(--radius-base);
    display: flex;
    gap: var(--space-4);
    justify-content: space-between;
    margin-top: var(--space-6);
    padding: var(--space-4);
}

.plus-tr-card-muted {
    color: var(--color-text-muted);
    display: block;
    font-size: var(--font-size-ui-sm);
}
</style>
