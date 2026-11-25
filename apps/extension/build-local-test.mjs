import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Use production-mode bundling for the disposable test package, without WXT's
// live reload server or development-mode web sockets.
const cli = fileURLToPath(new URL('./node_modules/wxt/bin/wxt.mjs', import.meta.url));
const result = spawnSync(process.execPath, [cli, 'build', '-b', 'chrome'], {
  stdio: 'inherit',
  env: { ...process.env, LABEL_AI_LOCAL_TEST: '1' },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
