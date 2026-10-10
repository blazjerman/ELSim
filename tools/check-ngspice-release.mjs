import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredArtifacts = [
  'ngspice.mjs',
  'ngspice.wasm',
  'ngspice-COPYING.txt',
  'ngspice-link.map',
  'ngspice-source.tar.gz',
  'ngspice-relink-objects.tar.gz',
  'THIRD_PARTY_NOTICES.md',
  'ngspice-build-info.txt',
  'ngspice-SHA256SUMS.txt',
];
const checksumCoveredArtifacts = requiredArtifacts.filter((name) => name !== 'ngspice-SHA256SUMS.txt');

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

export async function checkNgspiceRelease(root = defaultRoot) {
  const engineDir = path.join(root, 'public', 'engine');
  const reviewPath = path.join(root, 'licenses', 'ngspice-distribution-review.json');
  const errors = [];
  const fail = (message) => errors.push(message);
  let review;
  try {
    review = JSON.parse(await readFile(reviewPath, 'utf8'));
  } catch {
    fail(`missing or invalid ${path.relative(root, reviewPath)}; copy the review template and obtain qualified review`);
    return errors;
  }

  if (review.status !== 'approved') fail('review status must be "approved"');
  if (!review.reviewer?.name || !review.reviewer?.qualification || !review.reviewer?.reviewedAt) {
    fail('reviewer name, qualification, and review date are required');
  }
  try {
    if (review.upstreamCommit !== (await readFile(path.join(root, 'engine/wasm/UPSTREAM_COMMIT'), 'utf8')).trim()) {
      fail('review upstreamCommit does not match engine/wasm/UPSTREAM_COMMIT');
    }
  } catch {
    fail('engine/wasm/UPSTREAM_COMMIT is missing');
  }
  if (!Array.isArray(review.linkedComponents) || review.linkedComponents.length === 0) {
    fail('review must inventory linkedComponents with source path, license, and obligations');
  } else {
    for (const [index, component] of review.linkedComponents.entries()) {
      if (!component.sourcePath || !component.license || !component.obligations) {
        fail(`linkedComponents[${index}] needs sourcePath, license, and obligations`);
      }
    }
  }
  if (!review.sourceAndRelinkingMaterials || !review.noticesVerified) {
    fail('review must confirm source/relinking materials and notice verification');
  }

  const sourceMaterials = review.sourceMaterials;
  const requiredSourceMaterials = ['ngspice-source.tar.gz', 'ngspice-relink-objects.tar.gz', 'ngspice-COPYING.txt', 'ngspice-link.map', 'THIRD_PARTY_NOTICES.md'];
  if (!Array.isArray(sourceMaterials) || !requiredSourceMaterials.every((name) => sourceMaterials.includes(name))) {
    fail(`review sourceMaterials must include ${requiredSourceMaterials.join(', ')}`);
  } else {
    const seen = new Set();
    for (const [index, material] of sourceMaterials.entries()) {
      if (typeof material !== 'string' || !material.trim() || path.isAbsolute(material) || material.split(/[\\/]/).includes('..')) {
        fail(`sourceMaterials[${index}] must be a safe relative path inside public/engine`);
        continue;
      }
      const normalized = path.normalize(material);
      if (seen.has(normalized)) fail(`sourceMaterials contains duplicate path: ${normalized}`);
      seen.add(normalized);
      try {
        const fullPath = path.resolve(engineDir, normalized);
        if (!fullPath.startsWith(`${engineDir}${path.sep}`)) throw new Error('outside engine directory');
        await readFile(fullPath);
      } catch {
        fail(`source/relinking material is missing from public/engine: ${normalized}`);
      }
    }
  }

  const buildInfo = await readFile(path.join(engineDir, 'ngspice-build-info.txt'), 'utf8').catch(() => '');
  const buildCommit = buildInfo.match(/^ngspice source commit: ([a-f\d]{40})$/m)?.[1];
  if (!buildCommit || review.upstreamCommit !== buildCommit) {
    fail('review upstreamCommit must match the source commit recorded in public/engine/ngspice-build-info.txt');
  }
  if (review.buildChecksumSha256 !== (await sha256(path.join(engineDir, 'ngspice-SHA256SUMS.txt')).catch(() => ''))) {
    fail('review buildChecksumSha256 must match the current ngspice-SHA256SUMS.txt; re-review changed build outputs');
  }

  for (const name of requiredArtifacts) {
    try {
      const actual = await sha256(path.join(engineDir, name));
      if (review.artifactSha256?.[name] !== actual) {
        fail(`${name} is absent from the approved hashes or has changed; re-review these exact artifacts`);
      }
    } catch {
      fail(`required generated artifact is missing: public/engine/${name}`);
    }
  }

  try {
    const lines = (await readFile(path.join(engineDir, 'ngspice-SHA256SUMS.txt'), 'utf8')).split(/\r?\n/).filter(Boolean);
    const listed = new Map();
    for (const line of lines) {
      const match = line.match(/^([a-f\d]{64})\s+\*?(.+)$/i);
      if (!match || listed.has(match[2])) {
        fail('ngspice-SHA256SUMS.txt contains a malformed or duplicate entry');
        break;
      }
      listed.set(match[2], match[1].toLowerCase());
    }
    for (const name of checksumCoveredArtifacts) {
      const expected = listed.get(name);
      if (!expected || expected !== (await sha256(path.join(engineDir, name)))) {
        fail(`ngspice-SHA256SUMS.txt is missing or has an incorrect digest for ${name}`);
      }
    }
  } catch {
    fail('ngspice-SHA256SUMS.txt is absent or could not be verified');
  }

  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = await checkNgspiceRelease();
  for (const error of errors) console.error(`ngspice release check failed: ${error}`);
  if (errors.length) {
    console.error('A passing check is a repository release gate, not legal advice or a substitute for qualified review.');
    process.exitCode = 1;
  }
}
