const cleanNotes = (value: unknown): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^详见\s*CHANGELOG\.md[。.]?$/i.test(text) ? '' : text;
};

export function normalizeUpdateNotes(value: unknown, version: string): string {
  if (typeof value === 'string') return cleanNotes(value);
  if (!Array.isArray(value)) return '';
  const match = value.find(
    (item) => item && String(item.version).replace(/^v/i, '') === version.replace(/^v/i, ''),
  );
  return cleanNotes(match?.note);
}

export function extractVersionNotes(markdown: string, version: string): string {
  const sections = markdown.split(/(?=^## \[)/m);
  return (
    sections
      .find((section) => section.match(/^## \[([^\]]+)\]/)?.[1] === version.replace(/^v/i, ''))
      ?.trim() ?? ''
  );
}

export async function resolveUpdateNotes(
  version: string,
  requestJson: (url: string) => Promise<unknown>,
  requestText: (url: string) => Promise<string>,
  knownRelease?: { tag_name?: unknown; body?: unknown },
): Promise<string> {
  const body = cleanNotes(knownRelease?.body);
  if (body) return body;
  const normalized = version.replace(/^v/i, '');
  const tags =
    typeof knownRelease?.tag_name === 'string'
      ? [knownRelease.tag_name]
      : [`v${normalized}`, normalized];
  for (const tag of tags) {
    if (!knownRelease) {
      try {
        const release = (await requestJson(
          `https://api.github.com/repos/hoowhoami/EchoMusic/releases/tags/${encodeURIComponent(tag)}`,
        )) as { body?: unknown };
        const notes = cleanNotes(release?.body);
        if (notes) return notes;
      } catch {
        /* The versioned changelog is also available without the API. */
      }
    }
    try {
      const markdown = await requestText(
        `https://raw.githubusercontent.com/hoowhoami/EchoMusic/${encodeURIComponent(tag)}/CHANGELOG.md`,
      );
      const notes = extractVersionNotes(markdown, normalized);
      if (notes) return notes;
    } catch {
      /* Try the alternate tag spelling, then report unavailable. */
    }
  }
  return '';
}
