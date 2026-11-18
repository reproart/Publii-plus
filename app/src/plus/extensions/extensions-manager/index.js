import ManagerLauncher from './ManagerLauncher.vue';

export default {
    id: 'extensions-manager',
    slots: {
        'app-plugins': ManagerLauncher,
        'app-themes': ManagerLauncher
    }
};
