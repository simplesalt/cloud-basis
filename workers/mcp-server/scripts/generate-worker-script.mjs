#!/usr/bin/env node
// Generates 30-mcp/worker-script.yaml: a Crossplane Script wrapping the
// bundle scripts/bundle.mjs just produced. Pure function of the bundle file
// plus this package's build inputs (see sourceInputPaths below), so the
// same inputs always produce byte-identical output — the pre-commit hook
// (.githooks/pre-commit) depends on that to detect a stale committed file.
//
// Usage: node scripts/generate-worker-script.mjs [--bundle <path>] [--config <path>] [--out <path>]
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '..', '..');

const ACCOUNT_ID = 'ba92fe12c6c1275f965c7c86e3b392ac';
const SCRIPT_NAME = 'main-mcp-server';
const COMPATIBILITY_DATE = '2026-09-01';

// etcd stores the Script with the bundle twice: in spec.forProvider.content
// and again in status.atProvider.content once the provider observes it.
// etcd refuses objects over 1.5 MiB (1,572,864 bytes), and a refused status
// write is silent: the Script never turns Ready and stops taking new
// versions. This budget leaves room for the rest of the object.
const MAX_STORED_CONTENT_BYTES = 1_350_000;

function parseArgs(argv) {
  const args = { bundle: 'dist/worker.js', config: 'config.json', out: '../../30-mcp/worker-script.yaml' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--bundle') args.bundle = argv[++i];
    else if (flag === '--config') args.config = argv[++i];
    else if (flag === '--out') args.out = argv[++i];
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

/** Recursively lists every file under `dir`, as paths relative to `packageRoot`, sorted for determinism. */
async function listFilesRecursive(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/**
 * sha256 over the build inputs named in the task: src/, package.json,
 * package-lock.json, config.json, build.sh and the generator itself (both
 * build scripts). Each file contributes its repo-relative path and its
 * exact bytes, so the digest changes if any input's content OR set of
 * files changes, and is independent of the machine's mtimes/locale/etc.
 */
async function sourceHash() {
  const inputs = [
    ...(await listFilesRecursive(join(packageRoot, 'src'))),
    join(packageRoot, 'package.json'),
    join(packageRoot, 'package-lock.json'),
    join(packageRoot, 'config.json'),
    join(packageRoot, 'build.sh'),
    join(packageRoot, 'scripts', 'bundle.mjs'),
    join(packageRoot, 'scripts', 'generate-worker-script.mjs'),
  ].sort();

  const hash = createHash('sha256');
  for (const file of inputs) {
    hash.update(relative(packageRoot, file).replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** A single-line YAML/JSON double-quoted scalar: no raw newlines, valid under both YAML and JSON escaping rules. */
function yamlDoubleQuoted(text) {
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else if (code === 0x2028) out += '\\u2028';
    else if (code === 0x2029) out += '\\u2029';
    else out += ch;
  }
  out += '"';
  return out;
}

// Upjet hands forProvider fields to Terraform, which reads every string as a
// template: ${ and %{ in the bundle must be doubled to reach Cloudflare as-is.
function terraformLiteral(text) {
  return text.replaceAll('${', () => '$${').replaceAll('%{', () => '%%{');
}

/** Bytes a string takes once Kubernetes stores it as JSON: Go escapes " \ and control characters, and writes < > & as \u00XX. */
function storedJsonBytes(text) {
  let bytes = 2;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"' || ch === '\\' || ch === '\n' || ch === '\r' || ch === '\t') bytes += 2;
    else if (ch === '<' || ch === '>' || ch === '&' || code < 0x20 || code === 0x2028 || code === 0x2029) bytes += 6;
    else bytes += Buffer.byteLength(ch);
  }
  return bytes;
}

function indent(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}

function renderManifest({ content, sourceSha256, kvNamespaceId }) {
  return `# Generated by workers/mcp-server/build.sh from workers/mcp-server/src — do not hand-edit.
apiVersion: workers.upjet-cloudflare.m.upbound.io/v1alpha1
kind: Script
metadata:
  name: ${SCRIPT_NAME}
  namespace: crossplane-system
  annotations:
    kustomize.toolkit.fluxcd.io/prune: disabled
    kustomize.toolkit.fluxcd.io/substitute: disabled
    cloud-basis/source-sha256: ${yamlDoubleQuoted(sourceSha256)}
  labels:
    entity: cluster
    capability: infra
spec:
  forProvider:
    accountId: ${ACCOUNT_ID}
    scriptName: ${SCRIPT_NAME}
    mainModule: index.js
    compatibilityDate: ${yamlDoubleQuoted(COMPATIBILITY_DATE)}
    compatibilityFlags:
      - global_fetch_strictly_public
    content: ${yamlDoubleQuoted(terraformLiteral(content))}
    # Exactly the block Cloudflare reports back, so the provider sees no
    # difference and does not re-upload on every reconcile.
    observability:
      enabled: true
      headSamplingRate: 1
      logs:
        enabled: true
        headSamplingRate: 1
        invocationLogs: true
        persist: true
    bindings:
${indent(
  `- name: OAUTH_KV
  type: kv_namespace
  namespaceId: ${yamlDoubleQuoted(kvNamespaceId)}
- name: ACCESS_CLIENT_SECRET
  type: secret_text
  textSecretRef:
    name: mcp-server-access-oidc
    key: attribute.saas_app.client_secret
- name: COOKIE_ENCRYPTION_KEY
  type: secret_text
  textSecretRef:
    name: mcp-server-runtime
    key: cookie_encryption_key
- name: MCP_SLUG
  type: secret_text
  textSecretRef:
    name: mcp-server-runtime
    key: mcp_slug`,
  6
)}
  providerConfigRef:
    kind: ProviderConfig
    name: ssint-main
`;
}

export async function generateWorkerScript({ bundle: bundlePath, config: configPath, out: outPath }) {
  const [content, config, sourceSha256] = await Promise.all([
    readFile(resolve(packageRoot, bundlePath), 'utf8'),
    readFile(resolve(packageRoot, configPath), 'utf8').then(JSON.parse),
    sourceHash(),
  ]);

  if (typeof config.kvNamespaceId !== 'string' || config.kvNamespaceId === '') {
    throw new Error('config.json is missing a string value for "kvNamespaceId"');
  }

  const storedBytes = storedJsonBytes(terraformLiteral(content)) + storedJsonBytes(content);
  if (storedBytes > MAX_STORED_CONTENT_BYTES) {
    throw new Error(
      `The bundle would take ${storedBytes} bytes of the Script object (spec plus observed copy), ` +
        `over the ${MAX_STORED_CONTENT_BYTES}-byte budget under etcd's object limit; shrink the bundle.`
    );
  }

  const manifest = renderManifest({ content, sourceSha256, kvNamespaceId: config.kvNamespaceId });
  const outFile = resolve(packageRoot, outPath);
  await writeFile(outFile, manifest);
  return outFile;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const outFile = await generateWorkerScript(args);
  process.stderr.write(`Generated ${relative(repoRoot, outFile)}\n`);
}
