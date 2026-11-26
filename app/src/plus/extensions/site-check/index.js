import SiteCheckCard from './SiteCheckCard.vue';
import SyncCheckNote from './SyncCheckNote.vue';

export default {
    id: 'site-check',
    slots: {
        'site-tools': SiteCheckCard,
        'sync-popup': SyncCheckNote
    }
};
