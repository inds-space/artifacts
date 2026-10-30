// HTML artifacts are served with `img-src data: blob:`, so any other image URL renders as a broken image.
// ponytail: regex scan, not a parser; it catches <img>/<source>/<image> URLs and CSS url(), which covers real-world galleries.
const IMAGE_ATTR = /<(?:img|source|image|input)\b[^>]*?\s(?:src|srcset|href|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;

export function remoteImageWarnings(html: string): string[] {
  const blocked = new Set<string>();
  for (const pattern of [IMAGE_ATTR, CSS_URL]) {
    for (const match of html.matchAll(pattern)) {
      const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      // srcset lists comma-separated candidates; check each URL.
      for (const url of value.split(/,\s+/).map((candidate) => candidate.trim().split(/\s+/, 1)[0] ?? "")) {
        if (url && !/^(?:data:|blob:|#)/i.test(url)) blocked.add(url);
      }
    }
  }
  if (!blocked.size) return [];
  const examples = [...blocked].slice(0, 3).join(", ");
  return [`${String(blocked.size)} image URL(s) will be blocked by the HTML Content-Security-Policy (img-src data: blob:), e.g. ${examples}. Embed images as data: URLs instead; publish payloads are limited to 8 MiB.`];
}
