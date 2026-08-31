export const sanitizePortableNetworkSettings = (
  settings: Record<string, unknown>,
): Record<string, unknown> => {
  if (typeof settings.proxyPacScript !== 'string') return settings;
  try {
    if (new URL(settings.proxyPacScript).protocol === 'file:') {
      delete settings.proxyPacScript;
      if (settings.proxyMode === 'pac_script') settings.proxyMode = 'system';
    }
  } catch {
    // Invalid PAC values are handled by the network settings normalizer on import.
  }
  return settings;
};
