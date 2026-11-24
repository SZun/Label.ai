import * as ort from 'onnxruntime-web/wasm';
import { createDetectorEngine } from './engine.ts';
import { MODEL } from './model.ts';
import { type LocalPolicy } from './policy.ts';
import { INPUT_SIZE } from './preprocess.ts';

/** Shared by the bundled browser runtime and offline developer evaluation. */
export async function createWasmEngine(bytes: Uint8Array, wasm: Uint8Array, policy: LocalPolicy) {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  delete ort.env.wasm.wasmPaths;
  ort.env.wasm.wasmBinary = wasm;
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'], graphOptimizationLevel: 'all', executionMode: 'sequential',
  });
  if (session.inputNames.length !== 1 || session.inputNames[0] !== MODEL.input || !session.outputNames.includes(MODEL.output)) {
    await session.release();
    throw new Error('Packaged model interface mismatch');
  }
  return createDetectorEngine({
    async run(input) {
      const tensor = new ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE]);
      try {
        const outputs = await session.run({ [MODEL.input]: tensor });
        try {
          const output = outputs[MODEL.output];
          if (!output || output.data.length !== 1 || typeof output.data[0] !== 'number') throw new Error('Invalid inference output');
          return output.data[0];
        } finally { for (const output of Object.values(outputs)) output.dispose(); }
      } finally { tensor.dispose(); }
    },
    dispose: () => session.release(),
  }, policy);

}
