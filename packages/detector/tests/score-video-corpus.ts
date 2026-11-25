/** Offline, developer-selected videos only. Expose per-frame evidence for paired policy comparisons. */
import { execFileSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateModelBytes, validateWasmBytes } from '../src/assets.ts';
import { MODEL, WASM_RUNTIME } from '../src/model.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';
import { createWasmEngine } from '../src/session.ts';
import { analyzeTemporalEvidence, type ScoredFrame } from '../src/temporal.ts';
import { verifyCorpusAsset } from './corpus-policy.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const [manifest, output, mode] = process.argv.slice(2);
if (!manifest || !output) throw new Error('Usage: score-video-corpus.ts MANIFEST OUTPUT');
const [model, wasm] = await Promise.all(
  [MODEL.filename, WASM_RUNTIME.filename].map(name => readFile(join(root, 'ml/weights', name))),
);
await Promise.all([validateModelBytes(model!), validateWasmBytes(wasm!)]);
const engine = await createWasmEngine(model!, wasm!, DEFAULT_POLICY);
const temporary = await mkdtemp(join(tmpdir(), 'label-video-scores-'));
try {
  await writeFile(output, '', { flag: 'wx' });
  for (const line of (await readFile(manifest, 'utf8')).trim().split(/\r?\n/)) {
    const row = JSON.parse(line);
    await verifyCorpusAsset(resolve(manifest), row.file, row.sha256);
    const assetDir = join(temporary, row.sha256);
    let result;
    try {
      const path = execFileSync('python', [join(root, 'ml/prepare-smoke.py'), resolve(manifest), assetDir,
        '--asset', row.sha256, '--browser-sampling', ...(mode === '--center-four-seconds' ? [mode] : [])], { encoding: 'utf8', timeout: 120000 }).trim();
      const [asset] = JSON.parse(await readFile(path, 'utf8'));
      const frames: ScoredFrame[] = [];
      for (const frame of asset.frames) {
        const rgba = new Uint8Array(await readFile(frame.rgba_path));
        const input = { rgba, width: frame.width, height: frame.height };
        const score = await engine.analyzeRgba(input);
        if (score.status !== 'COMPLETED' || score.logit === undefined) throw new Error('Frame inference failed');
        frames.push({ ...input, timestampMs: frame.timestampMs, logit: score.logit });
      }
      const temporal = analyzeTemporalEvidence(frames, asset.durationMs);
      // Four-frame summaries can veto anomalous intros when probing a fitted model.
      // Keep whole-clip timing so pair support and derivative units stay identical.
      const thirds = [0, 1, 2].map(k => {
        const group = frames.filter(frame => Math.min(2, Math.floor(3 * frame.timestampMs / asset.durationMs)) === k);
        return group.length ? analyzeTemporalEvidence(group, asset.durationMs) : null;
      });
      result = { durationMs: asset.durationMs, temporal, thirds,
        logits: frames.map(f => f.logit), timestamps: frames.map(f => f.timestampMs) };
    } catch (err) {
      result = { error: err instanceof Error ? err.message.slice(0, 500) : String(err) };
    } finally {
      await rm(assetDir, { recursive: true, force: true });
    }
    await appendFile(output, JSON.stringify({ ...row, ...result }) + '\n');
    console.log(row.file, 'error' in result ? result.error : result.temporal.scoreQuantile25);
  }
} finally {
  await engine.dispose();
  await rm(temporary, { recursive: true, force: true });
}
