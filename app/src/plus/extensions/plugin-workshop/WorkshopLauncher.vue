<template>
    <div class="plus-ws-launcher">
        <div>
            <strong>Plugin workshop</strong>
            <span class="plus-ws-launcher-text">
                Publii Plus · make your own copy of a plugin or create a new one, edit and check it, export changes as .diff, see the hook log.
            </span>
        </div>
        <p-button
            appearance="outline"
            :onClick="() => { open = true; }">Open workshop</p-button>

        <plus-plugin-workshop
            v-if="open"
            @close="open = false" />
    </div>
</template>

<script>
import PluginWorkshop from './PluginWorkshop.vue';

export default {
    name: 'plus-workshop-launcher',
    components: { 'plus-plugin-workshop': PluginWorkshop },
    props: ['context'],
    data () {
        return { open: false };
    }
};
</script>

<style>
.plus-ws-launcher {
    align-items: center;
    background: var(--bg-secondary);
    border-radius: var(--radius-base);
    display: flex;
    gap: var(--space-4);
    justify-content: space-between;
    margin-bottom: var(--space-6);
    padding: var(--space-4);
}

.plus-ws-launcher-text {
    color: var(--color-text-muted);
    display: block;
    font-size: var(--font-size-ui-sm);
}
</style>
