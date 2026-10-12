export function elevenLabsLanguageCode(sourceLanguage: string): string | undefined {
  const normalized = sourceLanguage.trim().toLowerCase();
  if (!normalized || normalized === 'auto') return undefined;

  switch (normalized) {
    case 'chinese':
    case 'mandarin':
    case 'simplified chinese':
    case 'traditional chinese':
      return 'zho';
    case 'english':
      return 'en';
  }

  const primary = normalized.split(/[-_]/)[0];
  switch (primary) {
    case 'zh':
      return 'zho';
    case 'en':
      return 'en';
    default:
      return undefined;
  }
}

export function openAiLanguageCode(sourceLanguage: string): string | undefined {
  const normalized = sourceLanguage.trim().toLowerCase();
  if (!normalized || normalized === 'auto') return undefined;

  switch (normalized) {
    case 'chinese':
    case 'mandarin':
    case 'simplified chinese':
    case 'traditional chinese':
      return 'zh';
    case 'english':
      return 'en';
  }

  const primary = normalized.split(/[-_]/)[0];
  return primary === 'zh' ? 'zh' : primary === 'en' ? 'en' : undefined;
}

/**
 * The Volcengine bigmodel_async endpoint expects its documented Mandarin hint.
 * Normalize Chinese variants to that value instead of sending an unvalidated
 * provider parameter.
 */
export function volcengineSaucLanguageCode(sourceLanguage: string): string | undefined {
  const normalized = sourceLanguage.trim().toLowerCase();
  if (!normalized || normalized === 'auto') return undefined;
  if (
    ['chinese', 'mandarin', 'simplified chinese', 'traditional chinese'].includes(normalized) ||
    normalized.split(/[-_]/)[0] === 'zh'
  ) {
    return 'zh-CN';
  }
  return normalized === 'en' || normalized.startsWith('en-') ? 'en' : undefined;
}
