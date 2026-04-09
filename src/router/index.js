import {createRouter, createWebHistory} from 'vue-router';

// 路由规则
const routes = [
    {
        path: '/',
        redirect: '/backup',
    },
    {
        path: '/backup',
        name: 'backup',
        component: () => import('../views/backup.vue'),
    },
];

// 创建路由实例
const router = createRouter({
    history: createWebHistory(),
    routes,
});

export default router;