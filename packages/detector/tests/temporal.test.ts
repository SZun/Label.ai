import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeTemporalEvidence, type ScoredFrame } from '../src/temporal.ts';

function frame(timestampMs: number, value = 64, logit = 6): ScoredFrame {
  const rgba = new Uint8Array(128 * 128 * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set([value, value, value, 255], i);
  return { rgba, width: 128, height: 128, timestampMs, logit };
}

test('VID-TEMP-01 poster/one frame never becomes a video verdict', () => {
  const evidence = analyzeTemporalEvidence([frame(0)], 10000);
  assert.equal(evidence.eligible, false);
  assert.ok(evidence.reasonCodes.includes('INSUFFICIENT_TEMPORAL_SAMPLES'));
});

test('VID-TEMP-02 first and last timestamps do not invent coverage', () => {
  const evidence = analyzeTemporalEvidence([frame(0), frame(5000), frame(10000)], 10000);
  assert.ok(evidence.coverage < 0.3);
  assert.equal(evidence.denseTriplets, 0);
  assert.equal(evidence.eligible, false);
});

test('VID-TEMP-03 a short high-score intro cannot label the full clip', () => {
  const frames = Array.from({ length: 12 }, (_, i) => frame(i * 1000, 50 + i, i < 3 ? 8 : -8));
  const evidence = analyzeTemporalEvidence(frames, 11000);
  assert.ok(evidence.scoreQuantile25 < 0.01);
  assert.ok(evidence.coverage >= 0.8);
  assert.ok(evidence.denseTriplets >= 8);
});

test('VID-TEMP-04 uses consecutive frame dynamics and second differences', () => {
  const linear = Array.from({ length: 12 }, (_, i) => frame(i * 500, 50 + i * 4));
  const flicker = Array.from({ length: 12 }, (_, i) => frame(i * 500, i % 2 ? 90 : 50));
  const a = analyzeTemporalEvidence(linear, 5500);
  const b = analyzeTemporalEvidence(flicker, 5500);
  assert.ok(a.motionEnergy > 0);
  assert.ok(b.secondOrderResidual > a.secondOrderResidual + 0.1);
});

test('VID-TEMP-05 repeated poster frames, invalid ordering, and unknown duration abstain', () => {
  const same = analyzeTemporalEvidence(Array.from({ length: 12 }, (_, i) => frame(i * 500)), 5500);
  assert.equal(same.eligible, false);
  assert.ok(same.reasonCodes.includes('NO_TEMPORAL_CHANGE'));
  assert.throws(() => analyzeTemporalEvidence([frame(500), frame(500)], 1000), /timestamp/i);
  assert.throws(() => analyzeTemporalEvidence([frame(500)], NaN), /duration/i);
});

test('requires a strict majority of at least two positive frames in each third', () => {
  const evidence = (logits: number[]) => analyzeTemporalEvidence(
    logits.map((value, i) => frame(250 + i * 500, 50 + i * 4, value)), 6000);
  assert.equal(evidence([1,1,1,-8, 1,1,1,-8, 1,1,1,-8]).sustainedFrameEvidence, true);
  assert.equal(evidence([1,1,1,1, 1,1,1,1, 1,1,-8,-8]).sustainedFrameEvidence, false);
  assert.equal(evidence([1,1,1,1, -8,-8,-8,-8, -8,-8,-8,-8]).sustainedFrameEvidence, false);
});
