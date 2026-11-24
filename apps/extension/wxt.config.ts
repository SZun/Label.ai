import { defineConfig } from 'wxt';
import { createRequire } from 'node:module';
import { access, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const provenanceRequire = createRequire(join(root, '../../packages/provenance/package.json'));

export default defineConfig({
  modules: ['@wxt-dev/module-svelte'],
  manifestVersion: 3,
  vite: () => ({
    plugins: [
      {
        name: 'label-ai-packaged-wasm-reference',
        enforce: 'pre',
        transform(code, id) {
          if (!id.includes('/onnxruntime-web/')) return;
          // ORT has two fallback URLs in its embedded ESM glue. Reuse the verified
          // public asset instead of Vite library mode inlining two extra 15 MB copies.
          const replaced = code.replace(
            /(new URL\(["'])ort-wasm-simd-threaded\.wasm(["'],\s*import\.meta\.url\))/g,
            '$1/models/ort-wasm-simd-threaded.wasm$2',
          );
          if (replaced !== code) return { code: replaced, map: null };
        },
      },
    ],
  }),
  manifest: {
    name: 'Label.ai',
    description:
      'Private, on-device analysis of visible images and videos. Media never leaves your device for analysis.',
    version: '0.1.0',
    incognito: 'not_allowed',
    permissions: ['storage', 'scripting'],
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    action: { default_title: 'Label.ai privacy and site access' },
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; worker-src 'self'; connect-src 'self';",
    },
  },
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      // WXT infers required hosts from runtime content-script matches. Access is optional here.
      delete (manifest as { host_permissions?: string[] }).host_permissions;
      if (manifest.content_scripts?.length)
        throw new Error('Label.ai must register scripts only after site consent.');
    },
    'build:before': async () => {
      try {
        await access(join(root, 'public/models/detectra-v3.onnx'));
        await access(join(root, 'public/models/ort-wasm-simd-threaded.wasm'));
      } catch {
        throw new Error(
          'Packaged model assets are missing. Run: node ml/provision-model.mjs apps/extension/public/models',
        );
      }
      const target = join(root, 'public/c2pa');
      await mkdir(target, { recursive: true });
      await copyFile(
        provenanceRequire.resolve('@contentauth/c2pa-wasm/c2pa.wasm'),
        join(target, 'c2pa_bg.wasm'),
      );
      const licenses = join(root, 'public/licenses');
      await mkdir(licenses, { recursive: true });
      const c2paRoot = dirname(provenanceRequire.resolve('@contentauth/c2pa-wasm/package.json'));
      await Promise.all([
        copyFile(join(c2paRoot, 'LICENSE'), join(licenses, 'C2PA-WASM-MIT.txt')),
        copyFile(
          join(root, '../../packages/provenance/assets/C2PA-TRUST-LIST-LICENSE.txt'),
          join(licenses, 'C2PA-TRUST-LIST-LICENSE.txt'),
        ),
        copyFile(
          join(root, 'node_modules/@smui/paper/LICENSE'),
          join(licenses, 'SMUI-APACHE-2.0.txt'),
        ),
        copyFile(join(root, 'node_modules/svelte/LICENSE.md'), join(licenses, 'SVELTE-MIT.txt')),
      ]);
    },
  },
});
