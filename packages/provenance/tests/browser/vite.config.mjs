import { fileURLToPath } from 'node:url';
export default {
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: { host: '127.0.0.1', port: 4173, strictPort: true, fs: { allow: [fileURLToPath(new URL('../../../..', import.meta.url))] } },
  optimizeDeps: { exclude: ['@contentauth/c2pa-web'] },
};
