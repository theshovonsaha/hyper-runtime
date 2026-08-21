import { mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const destination = resolve(process.env.HYPER_PACKAGE_OUTPUT ?? join(root, 'dist', 'packages'));
mkdirSync(destination, { recursive: true });
const order = ['contracts','runtime','capability-memory','capabilities','context','delegation','model','planning','workflow','cli','evals'];

for (const directory of order) {
  const cwd = join(root, 'packages', directory);
  const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { name: string };
  const pack = Bun.spawn(['bun', 'pm', 'pack', '--quiet', '--destination', destination], {
    cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env,
  });
  const [packed, packError, packExit] = await Promise.all([
    new Response(pack.stdout).text(), new Response(pack.stderr).text(), pack.exited,
  ]);
  if (packExit !== 0) throw new Error(`${manifest.name} pack failed: ${packError}`);
  const tarball = packed.trim().split('\n').at(-1);
  if (!tarball) throw new Error(`${manifest.name} did not produce a tarball.`);
  const tarballPath = isAbsolute(tarball) ? tarball : resolve(destination, tarball);
  const publish = Bun.spawn(['npm', 'publish', tarballPath, '--access', 'public', '--provenance'], {
    cwd: root, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', env: process.env,
  });
  if (await publish.exited !== 0) throw new Error(`${manifest.name} publish failed.`);
}
