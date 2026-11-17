import AiPanel from './AiPanel.vue';
import AiSettings from './AiSettings.vue';

export default {
    id: 'ai-assistant',
    slots: {
        'post-editor-sidebar': AiPanel,
        'app-settings': AiSettings
    }
};
