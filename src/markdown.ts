import { Marked } from "marked";
import GithubSlugger from "github-slugger";
import sanitizeHtml from "sanitize-html";
import { markdownCss } from "./markdown-css";

export const MAX_MARKDOWN_BYTES = 8 * 1024 * 1024;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

/** Render a stored Markdown source without modifying its bytes or metadata. */
export function renderMarkdown(source: string, title: string): string {
  // Per-document slugger: duplicate headings remain stable without sharing state across requests.
  const slugger = new GithubSlugger();
  const parser = new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        const plain = sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} });
        const id = `user-content-${slugger.slug(plain)}`;
        return `<h${String(depth)} id="${escapeHtml(id)}">${text}</h${String(depth)}>\n`;
      },
      link({ href, title: linkTitle, tokens }) {
        // Match the heading prefix for ordinary Markdown fragment links.
        const target = href.startsWith("#") ? `#user-content-${href.slice(1)}` : href;
        return `<a href="${escapeHtml(target)}"${linkTitle ? ` title="${escapeHtml(linkTitle)}"` : ""}>${this.parser.parseInline(tokens)}</a>`;
      },
    },
  });
  const content = sanitizeHtml(parser.parse(source, { async: false }), {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, "img", "input", "del", "details", "summary"],
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "title", "width", "height"],
      code: ["class"],
      ol: ["start"],
      li: ["class"],
      ul: ["class"],
      th: ["align"],
      td: ["align"],
      h1: ["id"], h2: ["id"], h3: ["id"], h4: ["id"], h5: ["id"], h6: ["id"],
      input: ["type", "checked", "disabled"],
      details: ["open"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["https", "http", "data"] },
    allowProtocolRelative: false,
    transformTags: {
      // Markdown checkboxes are display-only, including any supplied as raw HTML.
      input: (_tagName, attribs) => ({ tagName: "input", attribs: {
        type: "checkbox", disabled: "", ...(Object.hasOwn(attribs, "checked") ? { checked: "" } : {}),
      } }),
    },
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${markdownCss}
html{color-scheme:light dark}body{margin:0;background:var(--bgColor-default,#fff)}
@media(prefers-color-scheme:dark){body{background:#0d1117}}
.markdown-body{box-sizing:border-box;min-width:0;max-width:980px;margin:0 auto;padding:40px;overflow-wrap:anywhere}
.markdown-body pre{overflow:auto}.markdown-body table{max-width:100%;overflow:auto}.markdown-body input[type=checkbox]{margin-right:.45em}
@media(max-width:600px){.markdown-body{padding:20px 16px}}
@media print{.markdown-body{max-width:none;padding:0}}
</style></head><body><main class="markdown-body">${content}</main></body></html>`;
}
