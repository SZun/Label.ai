#!/usr/bin/env node
/** Developer build step only. Never included in extension runtime. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, rename, copyFile, stat } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(join(here, 'model-manifest.json'), 'utf8'));
const target = resolve(process.argv[2] ?? join(here, 'weights'));
await mkdir(target, { recursive: true });
const modelPath = join(target, manifest.filename);

function verify(bytes) {
  if (bytes.length !== manifest.bytes || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) {
    throw new Error('Model size or SHA256 verification failed; refusing to package it.');
  }
}

let available = false;
try { verify(await readFile(modelPath)); available = true; } catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (!available) {
  const cached = join(here, 'weights', manifest.filename);
  if (cached !== modelPath) {
    try { const bytes = await readFile(cached); verify(bytes); await writeFile(modelPath, bytes); available = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
if (!available) {
  const response = await fetch(manifest.url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw new Error(`Model provisioning failed: HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > manifest.bytes) throw new Error('Model response exceeded the pinned size');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  verify(bytes);
  await writeFile(`${modelPath}.partial`, bytes);
  await rename(`${modelPath}.partial`, modelPath);
}

const require = createRequire(join(here, '../packages/detector/package.json'));
const runtimeRoot = dirname(dirname(require.resolve('onnxruntime-web/wasm')));
const runtimeManifest = JSON.parse(await readFile(join(runtimeRoot, 'package.json'), 'utf8'));
if (runtimeManifest.version !== manifest.onnxruntime_version) throw new Error('The WASM runtime version does not match the pinned manifest');
const resources = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];
for (const resource of resources) await copyFile(join(runtimeRoot, 'dist', resource), join(target, resource));
await copyFile(join(here, 'licenses', 'ONNXRUNTIME-LICENSE.txt'), join(target, 'ONNXRUNTIME-LICENSE.txt'));
await copyFile(join(here, 'licenses', 'DETECTRA-MIT.txt'), join(target, 'DETECTRA-LICENSE.txt'));
await copyFile(join(here, 'model-manifest.json'), join(target, 'model-manifest.json'));
const assets = await Promise.all([manifest.filename, ...resources].map(async file => ({
  file, bytes: (await stat(join(target, file))).size,
  sha256: createHash('sha256').update(await readFile(join(target, file))).digest('hex'),
})));
await writeFile(join(target, 'asset-checksums.json'), JSON.stringify({ onnxruntime_version: runtimeManifest.version, assets }, null, 2) + '\n');
console.log(JSON.stringify({ target, model: manifest.model_id, sha256: manifest.sha256, resources }, null, 2));
