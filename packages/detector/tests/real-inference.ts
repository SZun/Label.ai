/** Explicit integration gate: real pinned weights, actual ONNX Runtime WASM,
 * real local media. This does not run as a fast unit test and does not claim release accuracy.
 */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web/wasm';
import { validateModelBytes } from '../src/assets.ts';
import { createDetectorEngine } from '../src/engine.ts';
import { MODEL } from '../src/model.ts';
import { INPUT_SIZE, PREPROCESSING_VERSION } from '../src/preprocess.ts';
import { TEMPORAL_FEATURE_VERSION } from '../src/temporal.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const manifestPath = resolve(process.argv[2] ?? join(root, 'artifacts/smoke-media/manifest.jsonl'));
const reportPath = resolve(process.argv[3] ?? join(root, 'ml/reports/image-smoke-wasm.json'));
const manifestHash = createHash('sha256').update(await readFile(manifestPath)).digest('hex');
const preparedPath = execFileSync('python', [join(root, 'ml/prepare-smoke.py'), manifestPath,
  join(root, 'ml/.cache', manifestHash)], { encoding: 'utf8' }).trim();
type PreparedFrame = { rgba_path: string; width: number; height: number; timestampMs: number };
type Prepared = { file: string; sha256: string; origin: string; kind: 'image' | 'video'; rgba_path?: string; width?: number; height?: number; durationMs?: number; frames?: PreparedFrame[] };
const fixtures = JSON.parse(await readFile(preparedPath, 'utf8')) as Prepared[];
assert.ok(fixtures.length >= 2, 'real smoke must cover more than one input');
const bytes = new Uint8Array(await readFile(join(root, 'ml/weights', MODEL.filename)));
await validateModelBytes(bytes);
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
const loadStart = performance.now();
const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', executionMode: 'sequential' });
const loadMs = performance.now() - loadStart;
assert.deepEqual(session.inputNames, [MODEL.input]);
assert.ok(session.outputNames.includes(MODEL.output));
let inferenceCalls = 0;
const engine = createDetectorEngine({
  async run(input) {
    inferenceCalls++;
    const tensor = new ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE]);
    try {
      const outputs = await session.run({ [MODEL.input]: tensor });
      try {
        const value = outputs[MODEL.output]!.data[0];
        assert.equal(typeof value, 'number');
        assert.ok(Number.isFinite(value));
        return Number(value);
      } finally { for (const output of Object.values(outputs)) output.dispose(); }
    } finally { tensor.dispose(); }
  },
  dispose: () => session.release(),
});
const rows = [];
try {
  for (const fixture of fixtures) {
    const started = performance.now();
    const result = fixture.kind === 'image'
      ? await engine.analyzeRgba({ rgba: new Uint8Array(await readFile(fixture.rgba_path!)), width: fixture.width!, height: fixture.height! })
      : await engine.analyzeVideoFrames({
        durationMs: fixture.durationMs!,
        frames: await Promise.all(fixture.frames!.map(async frame => ({
          rgba: new Uint8Array(await readFile(frame.rgba_path)), width: frame.width, height: frame.height, timestampMs: frame.timestampMs,
        }))),
      });
    assert.equal(result.status, 'COMPLETED', `${fixture.file}: ${result.reasonCodes}`);
    assert.equal(result.shouldLabel, false, 'unvalidated routes must stay disabled even on genuine AI fixtures');
    if (fixture.kind === 'image') assert.ok(Number.isFinite(result.score));
    else assert.ok(result.temporal && result.temporal.coverage >= 0.8, 'real clip must exercise dense temporal coverage');
    const row = { file: fixture.file, sha256: fixture.sha256, kind: fixture.kind, origin: fixture.origin, elapsedMs: performance.now() - started, ...result };
    rows.push(row);
    console.log(JSON.stringify({ file: row.file, status: row.status, rawScore: row.rawScore, elapsedMs: Math.round(row.elapsedMs), reasons: row.reasonCodes }));
  }
  assert.ok(inferenceCalls >= 2, 'must perform real network inference more than once');
  assert.ok(new Set(rows.map(row => row.rawScore)).size >= 2, 'distinct media must produce distinct pixel-dependent results');
} finally { await engine.dispose(); }
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify({
  schemaVersion: 1, purpose: 'DEVELOPER_SMOKE_ONLY_NOT_RELEASE_VALIDATION', generatedAt: new Date().toISOString(),
  runtime: 'onnxruntime-web/wasm', runtimeVersion: ort.env.versions.web, numThreads: 1,
  environment: { node: process.version, platform: process.platform, architecture: process.arch },
  modelId: MODEL.id, modelSha256: MODEL.sha256, preprocessingVersion: PREPROCESSING_VERSION,
  temporalFeatureVersion: TEMPORAL_FEATURE_VERSION, manifestSha256: manifestHash, loadMs, inferenceCalls,
  imageRouteApproved: false, videoRouteApproved: false,
  limitations: ['Small, public fixtures are not a generator/site-disjoint release holdout.',
    'No video training/calibration artifact is bundled. Temporal raw score is a robust frame-score diagnostic, not a validated probability.',
    'Node WASM verifies inference; browser and Safari extension installation require separate evidence.'],
  rows,
}, null, 2) + '\n');
console.log(`Report: ${reportPath}`);
