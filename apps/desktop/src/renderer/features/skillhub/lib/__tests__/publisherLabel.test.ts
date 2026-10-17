import { describe, expect, it } from 'vitest';

import { skillPublisherLabel } from '../publisherLabel';

describe('skillPublisherLabel', () => {
  it('shows both the member publisher and organization owner', () => {
    expect(skillPublisherLabel({
      publisherName: 'Watchdog Publisher',
      authorName: 'Acme',
    })).toBe('Watchdog Publisher · Acme');
  });

  it('does not duplicate a personal owner fallback', () => {
    expect(skillPublisherLabel({
      publisherName: 'Watchdog Publisher',
      authorName: 'Watchdog Publisher',
    })).toBe('Watchdog Publisher');
  });
});
