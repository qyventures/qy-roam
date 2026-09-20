import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const standalone = resolve(root, '.next/standalone');
const sources = [
  { source: resolve(root, 'public'), destination: resolve(standalone, 'public') },
  { source: resolve(root, '.next/static'), destination: resolve(standalone, '.next/static') },
];

if (!existsSync(resolve(standalone, 'server.js'))) {
  throw new Error('Next standalone server is missing; run this only after a successful next build');
}

for (const { source, destination } of sources) {
  if (!existsSync(source)) throw new Error(`Required standalone asset source is missing: ${source}`);
  // Keep the deployable artifact exact across repeated local builds. Next
  // normally recreates `.next/standalone`, but removing the narrow target
  // first also prevents a changed/removed public asset surviving in a reused
  // build directory.
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(resolve(destination, '..'), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

console.log('Standalone artifact packaged with public and Next static assets.');
