import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import App from './App.vue';
import router from './router';
import './styles.css';
import { i18n } from './i18n';

createApp(App).use(i18n).use(createPinia()).use(router).use(ElementPlus).mount('#app');
