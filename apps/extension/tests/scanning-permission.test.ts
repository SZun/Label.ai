import { expect, it, vi } from 'vitest';
import { ScanningPermission } from '../src/core/scanning-permission';

it('allows no capture before a successful browser admission and expires stale permission', async () => {
  let time = 1_000;
  const request = vi.fn().mockResolvedValue({ allowed: true });
  const permission = new ScanningPermission(request, () => time);
  expect(permission.allowed).toBe(false);
  await permission.refresh();
  expect(permission.allowed).toBe(true);
  time += 10_001;
  expect(permission.allowed).toBe(false);
});

it('an explicitly denied or failed renewal cancels the previous admission', async () => {
  const request = vi.fn().mockResolvedValue({ allowed: true });
  const permission = new ScanningPermission(request);
  await permission.refresh();
  expect(permission.allowed).toBe(true);
  request.mockResolvedValue({ allowed: false });
  await permission.refresh();
  expect(permission.allowed).toBe(false);
  request.mockRejectedValue(new Error('permission check failed'));
  await permission.refresh();
  expect(permission.allowed).toBe(false);
});

it('discards a late reply after invalidation and avoids duplicate in-flight checks', async () => {
  let complete!: (reply: unknown) => void;
  const request = vi.fn(
    () =>
      new Promise<unknown>((resolve) => {
        complete = resolve;
      }),
  );
  const permission = new ScanningPermission(request);
  const pending = permission.refresh();
  await permission.refresh();
  expect(request).toHaveBeenCalledOnce();
  permission.invalidate();
  complete({ allowed: true });
  await pending;
  expect(permission.allowed).toBe(false);
});

it('keeps a current grant while a slow background check is pending but fails closed on timeout', async () => {
  vi.useFakeTimers();
  let time = 1_000;
  try {
    const request = vi.fn().mockResolvedValue({ allowed: true });
    const permission = new ScanningPermission(request, () => time);
    await permission.refresh();
    request.mockReturnValue(new Promise(() => {}));
    const pending = permission.refresh();
    time += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(permission.allowed).toBe(true);
    time += 3_000;
    await vi.advanceTimersByTimeAsync(3_000);
    await pending;
    expect(permission.allowed).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
