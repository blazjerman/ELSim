import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredArtifacts = [
  'ngspice.mjs',
  'ngspice.wasm',
  'ngspice-COPYING.txt',
  'emscripten-LICENSE.txt',
  'emscripten-musl-COPYRIGHT.txt',
  'ngspice-link.map',
  'ngspice-linked-object-inventory.json',
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
  try {
    const inventory = JSON.parse(await readFile(path.join(engineDir, 'ngspice-linked-object-inventory.json'), 'utf8'));
    if (!Array.isArray(inventory.objects) || inventory.objects.length === 0) {
      fail('ngspice-linked-object-inventory.json must contain linked objects before release review');
    } else {
      const reviewed = review.reviewedLinkedObjects;
      if (!Array.isArray(reviewed)) {
        fail('review must include reviewedLinkedObjects covering every generated linked-object path');
      } else {
        const entries = new Map();
        for (const [index, item] of reviewed.entries()) {
          if (!item.objectPath || !item.sourcePath || !item.license || !item.obligations) {
            fail(`reviewedLinkedObjects[${index}] needs objectPath, sourcePath, license, and obligations`);
          }
          if (entries.has(item.objectPath)) fail(`reviewedLinkedObjects contains duplicate objectPath: ${item.objectPath}`);
          entries.set(item.objectPath, item);
        }
        for (const object of inventory.objects) {
          const item = entries.get(object.objectPath);
          if (!item) fail(`linked object is not covered by review: ${object.objectPath}`);
          else if (object.sourcePath && item.sourcePath !== object.sourcePath) {
            fail(`reviewed sourcePath does not match generated candidate for ${object.objectPath}`);
          }
        }
        for (const objectPath of entries.keys()) {
          if (!inventory.objects.some((object) => object.objectPath === objectPath)) {
            fail(`reviewedLinkedObjects contains an object absent from the generated inventory: ${objectPath}`);
          }
        }
      }
    }
  } catch {
    fail('ngspice-linked-object-inventory.json is missing or invalid; rebuild and review the generated linked-object inventory');
  }
  if (!review.sourceAndRelinkingMaterials || !review.noticesVerified) {
    fail('review must confirm source/relinking materials and notice verification');
  }

  const sourceMaterials = review.sourceMaterials;
  const requiredSourceMaterials = ['ngspice-source.tar.gz', 'ngspice-relink-objects.tar.gz', 'ngspice-COPYING.txt', 'emscripten-LICENSE.txt', 'emscripten-musl-COPYRIGHT.txt', 'ngspice-link.map', 'ngspice-linked-object-inventory.json', 'THIRD_PARTY_NOTICES.md'];
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
