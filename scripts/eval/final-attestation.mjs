#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

/**
 * Enumerate all code files in the specified roots.
 * Filter: .ts, .js, .mjs, .cjs, .json
 * Format: POSIX relative path from rootDir without leading ./
 */
function enumerateCodeFiles(roots) {
  const allowedExts = new Set(['.ts', '.js', '.mjs', '.cjs', '.json']);
  const results = [];

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        // Skip hidden directories or build output if any
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (allowedExts.has(ext)) {
          const relPath = path.relative(rootDir, fullPath).split(path.sep).join('/');
          results.push({
            fullPath,
            relPath,
          });
        }
      }
    }
  }

  for (const root of roots) {
    const targetDir = path.join(rootDir, root);
    if (fs.existsSync(targetDir)) {
      walk(targetDir);
    }
  }

  return results;
}

/**
 * Calculate single-file SHA-256 and byte length.
 */
function hashFile(fullPath) {
  const buf = fs.readFileSync(fullPath);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return { sha256, bytes: buf.length };
}

/**
 * Main attestation computation.
 */
export function generateAttestation() {
  const roots = ['src', 'tests', 'scripts'];
  const codeFiles = enumerateCodeFiles(roots);

  // Collect records
  const fileRecords = codeFiles.map(({ fullPath, relPath }) => {
    const { sha256, bytes } = hashFile(fullPath);
    return {
      path: relPath,
      sha256,
      bytes,
    };
  });

  // Ordinal path sort (Unicode code points)
  fileRecords.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Build lines: `${path}:${sha256}`
  const lines = fileRecords.map(r => `${r.path}:${r.sha256}`);

  // Join with LF, NO trailing LF
  const joinedPayload = lines.join('\n');

  // Compute composite SHA-256
  const compositeSha256 = crypto
    .createHash('sha256')
    .update(joinedPayload, 'utf8')
    .digest('hex');

  // Query git HEAD
  let gitHead = 'unknown';
  try {
    gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir })
      .toString()
      .trim();
  } catch (err) {
    console.warn('Warning: unable to get git HEAD:', err.message);
  }

  // Compute code-surface tracked diff
  // Explicitly exclude docs/P62_STATUS.md and docs/reports/** to eliminate self-referential drift
  const diffExcludes = [':(exclude)docs/P62_STATUS.md', ':(exclude)docs/reports/**'];
  let trackedDiff = {
    command: "git diff -- . ':(exclude)docs/P62_STATUS.md' ':(exclude)docs/reports/**'",
    sha1Blob: '',
    sha256: '',
    bytes: 0,
    fileCount: 0,
    files: [],
  };

  try {
    const diffBuf = execFileSync(
      'git',
      ['diff', '--', '.', ...diffExcludes],
      { cwd: rootDir, maxBuffer: 50 * 1024 * 1024 }
    );
    const diffSha256 = crypto.createHash('sha256').update(diffBuf).digest('hex');
    const sha1Blob = execFileSync('git', ['hash-object', '--stdin'], {
      input: diffBuf,
      cwd: rootDir,
    })
      .toString()
      .trim();

    const nameOnlyOutput = execFileSync(
      'git',
      ['diff', '--name-only', '--', '.', ...diffExcludes],
      { cwd: rootDir }
    )
      .toString()
      .trim();

    const diffFiles = nameOnlyOutput ? nameOnlyOutput.split(/\r?\n/).map(f => f.split(path.sep).join('/')) : [];

    trackedDiff = {
      command: "git diff -- . ':(exclude)docs/P62_STATUS.md' ':(exclude)docs/reports/**'",
      description: 'Code surface tracked diff excluding self-referential P62_STATUS and closure reports',
      sha1Blob,
      sha256: diffSha256,
      bytes: diffBuf.length,
      fileCount: diffFiles.length,
      files: diffFiles,
    };
  } catch (err) {
    console.warn('Warning: unable to calculate git diff:', err.message);
  }

  const manifest = {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    gitHead,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    algorithm: {
      roots,
      fileExtensions: ['.ts', '.js', '.mjs', '.cjs', '.json'],
      pathFormat: 'POSIX relative without leading ./',
      sorting: 'ordinal path (Unicode code points)',
      lineFormat: '${path}:${fileSha256}',
      separator: '\\n (LF)',
      trailingNewline: false,
      encoding: 'utf-8',
      compositeHash: "SHA256(lines.join('\\n'))",
    },
    fileCount: fileRecords.length,
    compositeSha256,
    trackedDiff,
    files: fileRecords,
  };

  return manifest;
}

// Execute if run directly
const isDirectExecution = process.argv[1] && (
  process.argv[1] === __filename ||
  path.resolve(process.argv[1]) === path.resolve(__filename)
);

if (isDirectExecution) {
  const manifest = generateAttestation();
  const outputPath = path.join(rootDir, 'docs/reports/final-attestation.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log('=== Final Codebase Attestation ===');
  console.log(`Git HEAD:          ${manifest.gitHead}`);
  console.log(`Code Files Count:  ${manifest.fileCount}`);
  console.log(`Composite SHA-256: ${manifest.compositeSha256}`);
  console.log(`Tracked Diff:`);
  console.log(`  Command:         ${manifest.trackedDiff.command}`);
  console.log(`  SHA-1 Blob:      ${manifest.trackedDiff.sha1Blob}`);
  console.log(`  SHA-256:         ${manifest.trackedDiff.sha256}`);
  console.log(`  Bytes:           ${manifest.trackedDiff.bytes}`);
  console.log(`  Modified Files:  ${manifest.trackedDiff.fileCount}`);
  console.log(`Output written to: ${path.relative(rootDir, outputPath)}`);
}
