/** Offline developer CLI. Read only a chosen local corpus, never browser data.
 * Output is JSONL and can feed calibration or the frozen candidate evaluator.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validateModelBytes, validateWasmBytes } from '../src/assets.ts';
import { createWasmEngine } from '../src/session.ts';
import { MODEL, WASM_RUNTIME } from '../src/model.ts';
import { DEFAULT_POLICY } from '../src/policy.ts';
import { PREPROCESSING_VERSION } from '../src/preprocess.ts';
import { TEMPORAL_FEATURE_VERSION } from '../src/temporal.ts';
import type { LocalResult } from '../src/engine.ts';
import { candidateDecision, candidatePolicy, verifyCorpusAsset } from './corpus-policy.ts';

type Row = {
  file: string; sha256: string; kind: 'image' | 'video'; origin: string; split: string;
  group: string; source: string; license: string; slice: string;
};
type Frame = { rgba_path: string; width: number; height: number; timestampMs: number };
type Prepared = Row & { rgba_path?: string; width?: number; height?: number; frames?: Frame[]; durationMs?: number };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { values } = parseArgs({ options: {
  manifest: { type: 'string' }, output: { type: 'string' },
  split: { type: 'string', default: 'development' }, candidate: { type: 'string' },
}, strict: true });
if (!values.manifest || !values.output || !['development', 'calibration', 'release'].includes(values.split!) ||
    (values.split === 'release') !== Boolean(values.candidate)) {
  throw new Error('Provide --manifest FILE --output FILE --split development|calibration|release; release requires --candidate FILE');
}
const manifest = resolve(values.manifest), output = resolve(values.output);
const manifestBytes = await readFile(manifest);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const manifestSha = digest(manifestBytes);
const rows: Row[] = manifestBytes.toString('utf8').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
const seen = new Set<string>(), releaseGroups = new Set<string>();
if (!rows.length) throw new Error('Corpus cannot be empty');
for (const row of rows) {
  if (!/^[a-f0-9]{64}$/.test(row.sha256) || seen.has(row.sha256) || row.split !== values.split ||
      !['image', 'video'].includes(row.kind) ||
      !['genuine', 'generated', 'mixed'].includes(row.origin) ||
      ![row.file, row.group, row.source, row.license, row.slice].every(value => typeof value === 'string' && value.trim())) {
    throw new Error('Corpus requires distinct digests, paths, split, origin, rights, source, group and slice');
  }
  if (values.split === 'release' && releaseGroups.has(row.group)) throw new Error('Release rows require distinct source groups');
  seen.add(row.sha256);
  releaseGroups.add(row.group);
}

const candidateBytes = values.candidate ? await readFile(resolve(values.candidate)) : undefined;
const candidate = candidateBytes && candidatePolicy(JSON.parse(candidateBytes.toString('utf8')), manifestSha, digest(candidateBytes));
if (candidate && rows.some(row => row.kind !== candidate.modality)) throw new Error('Candidate must use a modality-specific release manifest');
const policy = candidate ? candidate.policy : DEFAULT_POLICY;
const weights = join(root, 'ml/weights');
const [model, wasm] = await Promise.all([readFile(join(weights, MODEL.filename)), readFile(join(weights, WASM_RUNTIME.filename))]);
await Promise.all([validateModelBytes(model), validateWasmBytes(wasm)]);

const engine = await createWasmEngine(model, wasm, policy);
const temp = await mkdtemp(join(tmpdir(), 'label-ai-corpus-'));
let total = 0;
try {
  await writeFile(output, '', { flag: 'wx' });
  for (const row of rows) {
    // Identity validation is outside decode fallback: missing files invalidate the run.
    await verifyCorpusAsset(manifest, row.file, row.sha256);
    const assetDir = join(temp, row.sha256);
    const started = performance.now();
    let result: LocalResult;
    try {
      const prepared = execFileSync('python', [join(root, 'ml/prepare-smoke.py'), manifest, assetDir,
        '--asset', row.sha256, '--browser-sampling'], { encoding: 'utf8', timeout: 120000 }).trim();
      const [fixture] = JSON.parse(await readFile(prepared, 'utf8')) as Prepared[];
      if (fixture?.sha256 !== row.sha256) throw new Error('Decoder identity mismatch');
      result = fixture.kind === 'image'
        ? await engine.analyzeRgba({ rgba: new Uint8Array(await readFile(fixture.rgba_path!)), width: fixture.width!, height: fixture.height! })
        : await engine.analyzeVideoFrames({
          durationMs: fixture.durationMs!,
          frames: await Promise.all(fixture.frames!.map(async frame => ({
            width: frame.width, height: frame.height, timestampMs: frame.timestampMs,
            rgba: new Uint8Array(await readFile(frame.rgba_path)),
          }))),
        });
    } catch (error) {
      // Count unsupported/malformed assets; never quietly drop them from recall.
      console.error(`Decode failed for ${row.sha256}: ${error instanceof Error ? error.message.slice(0, 400) : 'Unknown error'}`);
      result = { status: 'FAILED', shouldLabel: false, classification: 'UNKNOWN',
        reasonCodes: ['LOCAL_CORPUS_DECODE_FAILED'], policyVersion: policy.version, modelVersion: MODEL.id };
    } finally {
      await rm(assetDir, { recursive: true, force: true });
    }
    if (result.shouldLabel) throw new Error('Unexpected enabled release route in development runner');
    const decision = candidate ? candidateDecision(result, row.kind, policy[row.kind].threshold) : 'abstain';
    await appendFile(output, JSON.stringify({ ...row, ...result, decision, policy: policy.version,
      route: 'local-forensic-' + row.kind, elapsedMs: performance.now() - started,
      modelSha256: MODEL.sha256, wasmSha256: WASM_RUNTIME.sha256,
      preprocessingVersion: PREPROCESSING_VERSION, temporalFeatureVersion: TEMPORAL_FEATURE_VERSION,
      manifestSha256: manifestSha }) + '\n');
    console.log(`${++total}/${rows.length} ${row.file} ${result.status} ${result.rawScore ?? '-'} ${decision}`);
  }
} finally {
  await engine.dispose();
  await rm(temp, { recursive: true, force: true });
}
