<template>
    <div class="plus-em-launcher">
        <div>
            <strong>Catalog &amp; updates</strong>
            <span class="plus-em-launcher-text">
                Publii Plus · install {{ context === 'theme' ? 'themes' : 'plugins' }} from catalogs or links, with a check before installing.
                <strong v-if="updates">{{ updates }} update(s) available.</strong>
            </span>
        </div>
        <div class="plus-em-launcher-buttons">
            <p-button
                appearance="outline"
                :onClick="() => openManager('link')">Install from link</p-button>
            <p-button
                :appearance="updates ? 'default' : 'outline'"
                :onClick="() => openManager('catalog')">{{ updates ? 'Show updates' : 'Open catalog' }}</p-button>
        </div>

        <plus-extensions-manager
            v-if="open"
            :type="context"
            :startTab="startTab"
            @updates="n => { updates = n; }"
            @close="open = false" />
    </div>
</template>

<script>
import ExtensionsManager from './ExtensionsManager.vue';

export default {
    name: 'plus-extensions-launcher',
    components: { 'plus-extensions-manager': ExtensionsManager },
    props: ['context'],
    data () {
        return { open: false, startTab: 'catalog', updates: 0 };
    },
    async mounted () {
        // quiet background check for updates of this kind
        try {
            const groups = await this.$plus.invoke('extensions-manager', 'catalog');
            this.updates = groups.flatMap(g => g.items).filter(i => i.status === 'update' && i.type === this.context).length;
        } catch (e) {
            this.updates = 0;
        }
    },
    methods: {
        openManager (tab) {
            this.startTab = tab;
            this.open = true;
        }
    }
};
</script>

<style>
.plus-em-launcher {
    align-items: center;
    background: var(--bg-secondary);
    border-radius: var(--radius-base);
    display: flex;
    gap: var(--space-4);
    justify-content: space-between;
    margin-bottom: var(--space-6);
    padding: var(--space-4);
}

.plus-em-launcher-text {
    color: var(--color-text-muted);
    display: block;
    font-size: var(--font-size-ui-sm);
}

.plus-em-launcher-buttons {
    display: flex;
    flex-shrink: 0;
    gap: var(--space-2);
}
</style>
