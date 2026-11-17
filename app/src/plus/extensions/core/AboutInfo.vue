<template>
    <p
        v-if="info"
        class="about-version plus-about">
        Publii Plus {{ info.plusVersion }} (based on Publii {{ info.upstreamVersion }})
        <template v-if="loadedExtensions.length">
            · extensions: {{ loadedExtensions.join(', ') }}
        </template>
        <template v-if="failedExtensions.length">
            · <strong>failed: {{ failedExtensions.join(', ') }}</strong>
        </template>
    </p>
</template>

<script>
export default {
    name: 'plus-core-about-info',
    props: ['context'],
    data () {
        return {
            info: null
        };
    },
    computed: {
        loadedExtensions () {
            return this.info ? this.info.extensions.filter(e => e.loaded).map(e => e.name) : [];
        },
        failedExtensions () {
            return this.info ? this.info.extensions.filter(e => !e.loaded).map(e => e.id) : [];
        }
    },
    async mounted () {
        try {
            this.info = await this.$plus.invoke('core', 'info');
        } catch (e) {
            this.info = null;
        }
    }
};
</script>
