import {createRouter, createWebHashHistory} from 'vue-router';

const routes = [
    {
        path: '/',
        redirect: '/main-view/backup',
    },
    {
        path: '/main-view',
        name: 'mainView',
        component: () => import('../views/main-view.vue'),
        children: [
            {
                path: 'backup',
                name: 'backup',
                component: () => import('../views/backup/index.vue'),
            },
        ]
    },
    {
        path: '/settings',
        name: 'settings',
        component: () => import('../views/settings.vue'),
        children: [
            {
                path: 'backup-setting',
                name: 'backupSetting',
                component: () => import('../views/backup/setting.vue'),
            }
        ]
    }
];

const router = createRouter({
    history: createWebHashHistory(),
    routes,
});

export default router;