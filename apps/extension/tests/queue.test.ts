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

it('admits playback into a thumbnail backlog and runs it before pending thumbnails', async () => {
  const queue = new BoundedQueue(1, 4, 1);
  const order: string[] = [];
  let finish!: () => void;
  queue.enqueue(
    'running',
    () =>
      new Promise<void>((r) => {
        finish = r;
      }),
  );
  const run = (name: string) => async () => {
    order.push(name);
  };
  expect(queue.enqueue('thumb1', run('thumb1'))).toBe(true);
  expect(queue.enqueue('thumb2', run('thumb2'))).toBe(true);
  expect(queue.enqueue('thumb3', run('thumb3'))).toBe(false);
  expect(queue.enqueue('video', run('video'), 'playback')).toBe(true);
  expect(queue.enqueue('video', run('duplicate'), 'playback')).toBe(false);
  expect(queue.size).toBe(4);
  finish();
  await new Promise((r) => setTimeout(r, 0));
  expect(order).toEqual(['video', 'thumb1', 'thumb2']);
});
