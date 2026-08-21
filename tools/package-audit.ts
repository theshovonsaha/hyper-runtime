import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dir, '..');
const packageRoot = join(root, 'packages');
const directories = readdirSync(packageRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort();

const temporary = mkdtempSync(join(tmpdir(), 'hyper-package-audit-'));
for (const directory of directories) {
  const cwd = join(packageRoot, directory);
  if (!existsSync(join(cwd, 'package.json'))) continue;
  const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as Record<string, unknown>;
  if (manifest.private === true) continue;
  if (manifest.license !== 'MIT' || !Array.isArray(manifest.files) || !manifest.files.includes('src')) {
    throw new Error(`${directory} is missing bounded package publication metadata.`);
  }
  const child = Bun.spawn(['bun', 'pm', 'pack', '--quiet', '--destination', temporary], {
    cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${directory} package dry-run failed:\n${stderr || stdout}`);
  const tarball = stdout.trim().split('\n').at(-1);
  if (!tarball) throw new Error(`${directory} did not produce a package tarball.`);
  const tarballPath = isAbsolute(tarball) ? tarball : resolve(temporary, tarball);
  const inspect = Bun.spawn(['tar', '-xOf', tarballPath, 'package/package.json'], {
    cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const packedManifest = await new Response(inspect.stdout).text();
  if (await inspect.exited !== 0) throw new Error(`${directory} packed manifest could not be inspected.`);
  if (/workspace:\*/.test(packedManifest)) throw new Error(`${directory} retained a workspace protocol in its packed manifest.`);
  console.log(`package ${String(manifest.name)}: dry-run ok`);
}
rmSync(temporary, { recursive: true, force: true });
