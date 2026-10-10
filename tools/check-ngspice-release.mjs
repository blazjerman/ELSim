import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = path.join(root, 'public', 'engine');
const reviewPath = path.join(root, 'licenses', 'ngspice-distribution-review.json');
const requiredArtifacts = [
  'ngspice.mjs',
  'ngspice.wasm',
  'ngspice-COPYING.txt',
  'ngspice-link.map',
  'THIRD_PARTY_NOTICES.md',
  'ngspice-build-info.txt',
  'ngspice-SHA256SUMS.txt',
];
const checksumCoveredArtifacts = requiredArtifacts.filter((name) => name !== 'ngspice-SHA256SUMS.txt');

function fail(message) {
  console.error(`ngspice release check failed: ${message}`);
  process.exitCode = 1;
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function main() {
  let review;
  try {
    review = JSON.parse(await readFile(reviewPath, 'utf8'));
  } catch {
    fail(`missing or invalid ${path.relative(root, reviewPath)}; copy the review template and obtain qualified review`);
    return;
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

  if (process.exitCode) {
    console.error('A passing check is a repository release gate, not legal advice or a substitute for qualified review.');
  }
}

await main();
