<template>
    <div class="plus-agent-launcher">
        <button
            type="button"
            :class="{ 'plus-agent-launch': true, 'is-open': open }"
            @click="open = !open">
            <span aria-hidden="true">✦</span> AI agent
        </button>
        <plus-agent-chat
            v-if="open"
            @close="open = false" />
    </div>
</template>

<script>
import AgentChat from './AgentChat.vue';

let lastOpen = false;

export default {
    name: 'plus-agent-launcher',
    components: { 'plus-agent-chat': AgentChat },
    data () {
        return { open: lastOpen };
    },
    watch: {
        open (value) {
            lastOpen = value;
        }
    }
};
</script>

<style>
.plus-agent-launcher {
    flex-shrink: 0;
    margin: var(--space-2) 0;
}

.plus-agent-launch {
    background: transparent;
    border: 1px solid var(--sidebar-preview-btn-border-color);
    border-radius: var(--radius-base);
    color: var(--sidebar-preview-btn-color);
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-ui-sm);
    padding: var(--space-2) var(--space-3);
    text-align: center;
    width: 100%;
}

.plus-agent-launch:hover,
.plus-agent-launch.is-open {
    border-color: var(--sidebar-preview-btn-border-color-hover);
    color: var(--sidebar-preview-btn-color-hover);
}
</style>
