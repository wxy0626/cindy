import { describe, expect, it } from 'vitest';

import { isCriticalBuildTarget } from '../plugin-vite-fork/src/target-classification.js';

describe('isCriticalBuildTarget', () => {
  it.each([
    'src/main/index.ts',
    'src/preload/preload.ts',
    'src/main/localDb/worker/dbWorker.ts',
  ])('classifies %s as critical', (input) => {
    expect(isCriticalBuildTarget(input)).toBe(true);
  });

  it.each([
    'src/main/localDb/worker/cleanupWorker.ts',
    'src/main/maker-ipc/worker.ts',
    'src/renderer/index.tsx',
  ])('classifies %s as deferred', (input) => {
    expect(isCriticalBuildTarget(input)).toBe(false);
  });

  it('recognizes Vite object and array inputs', () => {
    expect(isCriticalBuildTarget({ db: 'src/main/localDb/worker/dbWorker.ts' })).toBe(true);
    expect(isCriticalBuildTarget(['src/renderer/index.tsx', 'src/preload/preload.ts'])).toBe(true);
  });
});
