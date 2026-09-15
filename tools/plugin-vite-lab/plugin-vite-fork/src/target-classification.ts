/** Returns whether a Vite build input is required before Electron startup. */
export function isCriticalBuildTarget(input: unknown): boolean {
  const targets: string[] = [];
  if (typeof input === 'string') {
    targets.push(input);
  } else if (Array.isArray(input)) {
    targets.push(...input.filter((item): item is string => typeof item === 'string'));
  } else if (input && typeof input === 'object') {
    targets.push(...Object.values(input).filter((item): item is string => typeof item === 'string'));
    targets.push(...Object.keys(input));
  }
  return targets.some((target) =>
    target.includes('src/main/index') ||
    target.includes('src/preload/preload') ||
    target.includes('src/main/localDb/worker/dbWorker'),
  );
}
