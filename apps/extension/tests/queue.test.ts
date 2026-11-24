import { expect, it } from 'vitest';
import { BoundedQueue } from '../src/core/queue';

it('DISC-05 bounds work, deduplicates and cancels queued items', async () => {
  const queue = new BoundedQueue(1, 2);
  let finish!: () => void;
  const called: string[] = [];
  expect(
    queue.enqueue(
      'a',
      () =>
        new Promise<void>((resolve) => {
          called.push('a');
          finish = resolve;
        }),
    ),
  ).toBe(true);
  expect(
    queue.enqueue('a', async () => {
      called.push('duplicate');
    }),
  ).toBe(false);
  expect(
    queue.enqueue('b', async () => {
      called.push('b');
    }),
  ).toBe(true);
  expect(
    queue.enqueue('c', async () => {
      called.push('c');
    }),
  ).toBe(false);
  expect(queue.active).toBe(1);
  queue.cancel('b');
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(called).toEqual(['a']);
  expect(queue.size).toBe(0);
});
