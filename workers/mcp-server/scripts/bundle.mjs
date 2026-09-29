#!/usr/bin/env node
// Bundles src/index.ts into a single minified ESM module for the Workers
// (workerd) runtime. Pure function of its inputs (source files + the named
// config file) so repeated runs are byte-identical — see build.sh and the
// pre-commit hook, both of which rely on that.
//
// Usage: node scripts/bundle.mjs [--config <path>] [--out <path>] [--entry <path>]
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { config: 'config.json', out: 'dist/worker.js', entry: 'src/index.ts' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--config') args.config = argv[++i];
    else if (flag === '--out') args.out = argv[++i];
    else if (flag === '--entry') args.entry = argv[++i];
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

/** Only the fields the bundle itself needs baked in; kvNamespaceId is manifest-only. */
function buildTimeConfig(config) {
  const { host, accessAuthDomain, accessClientId } = config;
  for (const [key, value] of Object.entries({ host, accessAuthDomain, accessClientId })) {
    if (typeof value !== 'string' || value === '') {
      throw new Error(`config.json is missing a string value for "${key}"`);
    }
  }
  return { host, accessAuthDomain, accessClientId };
}

export async function bundle({ config: configPath, out: outPath, entry: entryPath }) {
  const configFile = resolve(packageRoot, configPath);
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const define = {
    __BUILD_CONFIG__: JSON.stringify(JSON.stringify(buildTimeConfig(config))),
  };

  const result = await build({
    entryPoints: [resolve(packageRoot, entryPath)],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    platform: 'neutral',
    // Matches how Wrangler itself resolves package "exports" conditions for
    // workerd, so @modelcontextprotocol/server picks its workerd shim
    // (dist/shimsWorkerd.mjs) instead of the Node one.
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['module', 'main'],
    minify: true,
    legalComments: 'none',
    // A workerd builtin, resolved by the runtime itself, never bundled.
    external: ['cloudflare:*'],
    define,
    logLevel: 'silent',
  });

  if (result.errors.length > 0) {
    throw new Error(result.errors.map((error) => error.text).join('\n'));
  }
  if (result.outputFiles.length !== 1) {
    throw new Error(`Expected exactly one esbuild output file, got ${result.outputFiles.length}`);
  }

  const outFile = resolve(packageRoot, outPath);
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, result.outputFiles[0].contents);
  return outFile;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const outFile = await bundle(args);
  const { size } = await import('node:fs').then((fs) => fs.promises.stat(outFile));
  process.stderr.write(`Bundled ${args.entry} -> ${outFile} (${size} bytes)\n`);
}
