import { expect, it } from 'vitest';
import { retryableReply, RetryBudget } from '../src/core/retry';
const binding = { instanceId: 'media', generation: 1, requestId: 'id' };
const reply = { ...binding, status: 'BUSY', shouldLabel: false };

it('retries only a current transient local response, never an unsupported or mismatched decision', () => {
  expect(retryableReply(binding, reply)).toBe(true);
  expect(retryableReply(binding, { ...reply, status: 'CANCELED' })).toBe(true);
  expect(retryableReply(binding, { ...reply, status: 'COMPLETED' })).toBe(false);
  expect(retryableReply(binding, { ...reply, status: 'UNSUPPORTED' })).toBe(false);
  expect(retryableReply(binding, { ...reply, requestId: 'old' })).toBe(false);
});

it('allows two delayed retries per source and never loops on continued local failure', () => {
  const budget = new RetryBudget();
  expect(budget.ready(1000)).toBe(true);
  expect(budget.defer(1000)).toBe(true);
  expect(budget.ready(1999)).toBe(false);
  expect(budget.ready(2000)).toBe(true);
  expect(budget.defer(2000)).toBe(true);
  expect(budget.ready(5999)).toBe(false);
  expect(budget.ready(6000)).toBe(true);
  expect(budget.defer(6000)).toBe(false);
  budget.reset();
  expect(budget.defer(7000)).toBe(true);
});
