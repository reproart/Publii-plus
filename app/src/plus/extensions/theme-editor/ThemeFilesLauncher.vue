<template>
    <div class="plus-te-launcher">
        <div>
            <strong>Theme files</strong>
            <span class="plus-te-muted">
                Edit templates, partials, CSS and JS of the theme. Changes are kept as overrides and survive theme updates.
            </span>
        </div>
        <p-button
            appearance="outline"
            :disabled="!siteName"
            :onClick="() => { open = true; }">Edit theme files</p-button>

        <plus-theme-editor
            v-if="open"
            :siteName="siteName"
            @close="open = false" />
    </div>
</template>

<script>
import ThemeEditor from './ThemeEditor.vue';

export default {
    name: 'plus-theme-files-launcher',
    components: { 'plus-theme-editor': ThemeEditor },
    props: ['context'],
    data () {
        return { open: false };
    },
    computed: {
        siteName () {
            const config = this.$store.state.currentSite.config;
            return config && config.name && config.name !== '!' ? config.name : '';
        }
    }
};
</script>

<style>
.plus-te-launcher {
    align-items: center;
    background: var(--bg-secondary);
    border-radius: var(--radius-base);
    display: flex;
    gap: var(--space-4);
    justify-content: space-between;
    margin-bottom: var(--space-6);
    padding: var(--space-4);
}

.plus-te-launcher .plus-te-muted {
    display: block;
}
</style>
