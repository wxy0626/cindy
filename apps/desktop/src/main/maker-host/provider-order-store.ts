/**
 * provider-order-store — owner-scoped provider display-order override.
 *
 * File: the active owner's namespace via ownerScopedUserDataPath('provider-order-prefs.json').
 * The persisted list is the order in which providers have appeared in Settings,
 * subsequently adjusted by explicit drag operations. Cindy AI seeds an empty list;
 * every other newly visible provider appends at the end.
 */

import {
  mergeObservedProviderOrder,
  normalizeProviderOrder,
} from '../../shared/providerOrder.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  machineSharedLegacyFileCandidates,
  machineSharedUserDataPath,
} from '../machineSharedStorage.js';
import { desktopMakerLogger } from './logger-adapter.js';
import { createOverrideSettingsFile } from './override-settings-file.js';

const log = desktopMakerLogger.child('provider-order-store');
const CINDY_AI_PROVIDER_ID = 'xd';

interface ProviderOrderPrefs {
  providerOrder: string[];
}

const DEFAULTS: ProviderOrderPrefs = { providerOrder: [] };
let legacySeedChecked = false;

function normalize(raw: unknown): ProviderOrderPrefs {
  if (!raw || typeof raw !== 'object') return { providerOrder: [] };
  return {
    providerOrder: normalizeProviderOrder((raw as { providerOrder?: unknown }).providerOrder),
  };
}

const store = createOverrideSettingsFile<ProviderOrderPrefs>({
  filePath: () => machineSharedUserDataPath('provider-order-prefs.json'),
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'provider-order',
});

function seedLegacyProviderOrder(): void {
  if (legacySeedChecked) return;
  legacySeedChecked = true;
  const target = machineSharedUserDataPath('provider-order-prefs.json');
  if (fs.existsSync(target)) return;
  let merged: string[] = [];
  for (const candidate of machineSharedLegacyFileCandidates('provider-order-prefs.json')) {
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf8')) as {
        providerOrder?: unknown;
      };
      merged = mergeObservedProviderOrder(merged, normalizeProviderOrder(raw.providerOrder));
    } catch (error) {
      log.warn('failed to read legacy provider order', { candidate, error: String(error) });
    }
  }
  if (merged.length === 0) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({ providerOrder: merged }, null, 2)}\n`, 'utf8');
}

export function readProviderOrder(): string[] {
  seedLegacyProviderOrder();
  store.invalidateIfChanged();
  const order = [...store.read().providerOrder];
  return order.includes(CINDY_AI_PROVIDER_ID) ? order : [CINDY_AI_PROVIDER_ID, ...order];
}

export function setProviderOrder(visibleProviderIds: readonly string[]): boolean {
  store.invalidateIfChanged();
  const current = readProviderOrder();
  const next = mergeObservedProviderOrder(current, normalizeProviderOrder(visibleProviderIds));
  if (next.length === current.length && next.every((id, index) => id === current[index])) {
    return false;
  }
  store.writePatch({ providerOrder: next });
  log.info('provider display order written', { count: next.length });
  return true;
}

export const __testing = {
  normalize,
  reset: () => {
    legacySeedChecked = false;
    return store.reset();
  },
};
