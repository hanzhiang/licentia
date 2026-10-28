import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const proxy = {
  '/api': {
    target: 'http://localhost:3001',
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/api/, ''),
  },
};

export default defineConfig({
  plugins: [vue()],
  server: { port: 5174, proxy },
  preview: { port: 5174, proxy },
});
