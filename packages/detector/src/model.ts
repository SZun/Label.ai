export const MODEL = Object.freeze({
  id: 'detectra-v3-vits16-384',
  filename: 'detectra-v3.onnx',
  sha256: '1414b9aafaa01a644ed706224973f09b53a1388282104409862df9893b1b962b',
  bytes: 43684258,
  revision: '2bbc31161daa46932e05ee6f96e7016ee817bbde',
  source: 'https://huggingface.co/TensorFold/detectra-v1',
  license: 'MIT',
  input: 'pixel_values',
  output: 'logit',
});

export const WASM_RUNTIME = Object.freeze({
  version: '1.31.1',
  filename: 'ort-wasm-simd-threaded.wasm',
  bytes: 14848852,
  sha256: '4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d',
});
