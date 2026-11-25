/** Developer-only pinned Loke model comparison. No production-policy integration. */
import { createHash } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import * as ort from 'onnxruntime-web/wasm';
import { validateWasmBytes } from '../src/assets.ts';
import { WASM_RUNTIME } from '../src/model.ts';
import { INPUT_SIZE, preprocessRgba, sigmoid } from '../src/preprocess.ts';

const MODEL_SHA = 'd431efd677cc124ab68c3f1b20d628b7e9a8362a99803b1878475060b05cff5a';
const [modelPath, preparedPath, outputPath] = process.argv.slice(2);
if (!modelPath || !preparedPath || !outputPath) throw new Error('Usage: compare-loke.ts MODEL PREPARED_JSON OUTPUT_JSONL');
const model = await readFile(modelPath);
if (model.length !== 23046673 || createHash('sha256').update(model).digest('hex') !== MODEL_SHA) throw new Error('Unexpected Loke model bytes');
const wasm = await readFile(resolve(join('ml/weights', WASM_RUNTIME.filename)));
await validateWasmBytes(wasm);
ort.env.wasm.wasmBinary = wasm;
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', executionMode: 'sequential' });
const rows = JSON.parse(await readFile(preparedPath, 'utf8')) as { file: string; kind: string; slice: string; origin: string; sha256: string; rgba_path: string; width: number; height: number }[];
try {
  if (session.inputNames.length !== 1 || session.outputNames.length !== 1 || rows.length !== 38 ||
      rows.some(row => row.kind !== 'image' || row.slice !== 'original')) throw new Error('Expected fixed frontier original image subset');
  await writeFile(outputPath, '', { flag: 'wx' });
  for (const row of rows) {
    const started = performance.now();
    const input = preprocessRgba({ rgba: await readFile(row.rgba_path), width: row.width, height: row.height });
    // Same 440 short edge/384 center crop. Map ImageNet-normalized
    // values back to channel intensities, then use candidate model.json's CLIP normalization.
    const imageMean = [.485, .456, .406], imageStd = [.229, .224, .225];
    const candidateMean = [.48145466, .4578275, .40821073], candidateStd = [.26862954, .26130258, .27577711];
    const plane = INPUT_SIZE * INPUT_SIZE;
    for (let c = 0; c < 3; c++) {
      const scale = imageStd[c]! / candidateStd[c]!;
      const offset = (imageMean[c]! - candidateMean[c]!) / candidateStd[c]!;
      for (let p = c * plane; p < (c + 1) * plane; p++) input[p] = input[p]! * scale + offset;
    }
    const tensor = new ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE]);
    let logit: number;
    try {
      const outputs = await session.run({ [session.inputNames[0]!]: tensor });
      try {
        const d = outputs[session.outputNames[0]!]!.data;
        if (d.length !== 1 || typeof d[0] !== 'number' || !Number.isFinite(d[0])) throw new Error('Unexpected candidate output');
        logit = d[0];
      } finally { for (const output of Object.values(outputs)) output.dispose(); }
    } finally { tensor.dispose(); }
    const result = { file: row.file, sha256: row.sha256, origin: row.origin, logit, score: sigmoid(logit),
      elapsedMs: performance.now() - started, modelSha256: MODEL_SHA };
    await appendFile(outputPath, JSON.stringify(result) + '\n');
    console.log(JSON.stringify(result));
  }
} finally { await session.release(); }
