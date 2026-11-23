<template>
    <div
        class="plus-modal-overlay"
        @mousedown.self="$emit('close')">
        <div
            class="plus-modal"
            role="dialog"
            aria-modal="true"
            :aria-label="title">
            <header class="plus-modal-header">
                <strong>{{ title }}</strong>
                <button
                    type="button"
                    class="plus-modal-close"
                    aria-label="Close"
                    @click="$emit('close')">×</button>
            </header>
            <div class="plus-modal-body">
                <slot />
            </div>
            <footer
                v-if="$slots.footer"
                class="plus-modal-footer">
                <slot name="footer" />
            </footer>
        </div>
    </div>
</template>

<script>
/**
 * Modal dialog rendered on <body> (so it is not clipped by sidebars). Closes on Esc and a click outside.
 */
export default {
    name: 'plus-modal',
    props: {
        title: { type: String, default: '' }
    },
    mounted () {
        document.body.appendChild(this.$el);
        document.addEventListener('keydown', this.onKey);
    },
    beforeDestroy () {
        document.removeEventListener('keydown', this.onKey);

        if (this.$el.parentNode) this.$el.parentNode.removeChild(this.$el);
    },
    methods: {
        onKey (event) {
            if (event.key === 'Escape') this.$emit('close');
        }
    }
};
</script>

<style>
.plus-modal-overlay {
    align-items: center;
    background: var(--overlay);
    display: flex;
    inset: 0;
    justify-content: center;
    padding: var(--space-6);
    position: fixed;
    z-index: var(--layer-popup);
}

.plus-modal {
    background: var(--popup-bg);
    border-radius: var(--radius-base);
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    font-size: var(--font-size-ui-md);
    max-height: 100%;
    max-width: 760px;
    width: 100%;
}

.plus-modal-header,
.plus-modal-footer {
    align-items: center;
    display: flex;
    gap: var(--space-2);
    padding: var(--space-4) var(--space-6);
}

.plus-modal-header strong {
    font-size: var(--font-size-ui-lg);
}

.plus-modal-header {
    border-bottom: 1px solid var(--color-border-subtle);
    justify-content: space-between;
}

.plus-modal-footer {
    border-top: 1px solid var(--color-border-subtle);
    flex-wrap: wrap;
}

.plus-modal-close {
    background: none;
    border: none;
    color: var(--color-text-muted);
    cursor: pointer;
    font-size: var(--font-size-ui-xl);
    line-height: 1;
    padding: 0 var(--space-1);
}

.plus-modal-body textarea {
    font: inherit;
    padding: var(--space-2);
}

.plus-modal-body {
    overflow-y: auto;
    padding: var(--space-4) var(--space-6);
    text-align: left;
}
</style>
