// HTML artifacts are served with `img-src data: blob: https:`. Relative image URLs resolve to the
// artifacts host, where the artifact's files don't exist, and `http:` URLs are blocked.
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
        if (url && !/^(?:data:|blob:|https:|#)/i.test(url)) blocked.add(url);
      }
    }
  }
  if (!blocked.size) return [];
  const examples = [...blocked].slice(0, 3).join(", ");
  return [`${String(blocked.size)} image URL(s) will not load in this HTML artifact, e.g. ${examples}. Only https:, data: and blob: images work (CSP img-src data: blob: https:); relative paths point at the artifacts host, which doesn't serve your files. Use absolute https URLs or data: URLs.`];
}
