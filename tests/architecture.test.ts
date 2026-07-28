import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap(entry => {
    if (entry === 'node_modules' || entry === 'dist') return [];
    const path = resolve(root, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('package boundaries', () => {
  test('public packages do not import the legacy prototype', () => {
    const files = sourceFiles(resolve(process.cwd(), 'packages'));
    const violations = files.filter(file => {
      const source = readFileSync(file, 'utf8');
      return /from\s+['"][^'"]*\/src\//.test(source)
        || /from\s+['"][^'"]*legacy/.test(source);
    });

    expect(violations).toEqual([]);
  });

  test('contracts remain dependency-free', () => {
    const files = sourceFiles(resolve(process.cwd(), 'packages/contracts'));
    const externalImports = files.flatMap(file => {
      const source = readFileSync(file, 'utf8');
      return [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)]
        .map(match => match[1])
        .filter(specifier => !specifier.startsWith('.'));
    });

    expect(externalImports).toEqual([]);
  });

  test('public packages follow the declared dependency graph', () => {
    const allowed: Record<string, string[]> = {
      contracts: [],
      runtime: ['@hyper/contracts'],
      'capability-memory': ['@hyper/contracts'],
      capabilities: ['@hyper/contracts'],
      context: ['@hyper/contracts'],
      delegation: ['@hyper/contracts'],
      model: ['@hyper/context', '@hyper/contracts'],
      planning: ['@hyper/contracts'],
      workflow: [
        '@hyper/context',
        '@hyper/contracts',
        '@hyper/delegation',
        '@hyper/model',
        '@hyper/runtime',
      ],
      cli: [
        '@hyper/capabilities',
        '@hyper/contracts',
        '@hyper/model',
        '@hyper/runtime',
        '@hyper/workflow',
      ],
      evals: [
        '@hyper/capability-memory',
        '@hyper/context',
        '@hyper/contracts',
        '@hyper/model',
        '@hyper/runtime',
        '@hyper/workflow',
      ],
    };
    const violations: string[] = [];
    for (const [packageName, importsAllowed] of Object.entries(allowed)) {
      for (const file of sourceFiles(resolve(process.cwd(), 'packages', packageName))) {
        const source = readFileSync(file, 'utf8');
        const localImports = [...source.matchAll(/from\s+['"](@hyper\/[^'"]+)['"]/g)]
          .map(match => match[1]);
        for (const imported of localImports) {
          if (!importsAllowed.includes(imported)) {
            violations.push(`${packageName}:${imported}:${file}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
