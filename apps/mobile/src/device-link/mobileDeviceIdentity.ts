export function buildMobileDeviceName(input: {
  constantsDeviceName?: string | null;
  platform: string;
}): string {
  const trimmed = input.constantsDeviceName?.trim();
  return trimmed || `Watchdog ${input.platform}`;
}
