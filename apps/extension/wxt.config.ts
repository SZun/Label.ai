import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-svelte'],
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: 'Label.ai',
    description: 'Private, on-device analysis of visible images and videos. Media never leaves your device for analysis.',
    version: '0.1.0',
    permissions: ['storage', 'scripting', ...(browser === 'chrome' ? ['offscreen'] : [])],
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    action: { default_title: 'Label.ai privacy and site access' },
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; worker-src 'self' blob:; connect-src 'self';",
    },
  }),
});
