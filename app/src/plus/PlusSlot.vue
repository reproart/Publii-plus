<template>
    <div
        v-if="entries.length"
        :class="'plus-slot plus-slot--' + name">
        <component
            v-for="entry in entries"
            :key="entry.extensionId"
            :is="entry.component"
            :context="context" />
    </div>
</template>

<script>
export default {
    name: 'plus-slot',
    props: {
        name: {
            type: String,
            required: true
        },
        context: {
            default: null
        }
    },
    computed: {
        entries () {
            return this.$plus ? this.$plus.getSlot(this.name) : [];
        }
    }
};
</script>
