import { defineConfig } from 'wxt';
import { createRequire } from 'node:module';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const provenanceRequire = createRequire(join(root, '../../packages/provenance/package.json'));

export default defineConfig({
  modules: ['@wxt-dev/module-svelte'],
  manifestVersion: 3,
  manifest: {
    name: 'Label.ai',
    description: 'Private, on-device analysis of visible images and videos. Media never leaves your device for analysis.',
    version: '0.1.0',
    permissions: ['storage', 'scripting'],
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    action: { default_title: 'Label.ai privacy and site access' },
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; worker-src 'self'; connect-src 'self';",
    },
  },
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      // WXT infers required hosts from runtime content-script matches. Access is optional here.
      delete (manifest as { host_permissions?: string[] }).host_permissions;
      if (manifest.content_scripts?.length) throw new Error('Label.ai must register scripts only after site consent.');
    },
    'build:before': async () => {
      const target = join(root, 'public/c2pa');
      await mkdir(target, { recursive: true });
      await copyFile(provenanceRequire.resolve('@contentauth/c2pa-wasm/c2pa.wasm'), join(target, 'c2pa_bg.wasm'));
    },
  },
});
