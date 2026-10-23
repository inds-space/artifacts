import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/markdown";

describe("GitHub-style Markdown", () => {
  it("renders GFM tables, task lists, strikethrough, links, and fenced code", () => {
    const html = renderMarkdown("# Report\n\n| A | B |\n| - | - |\n| one | two |\n\n- [x] Done\n- [ ] Todo\n\n~~old~~\n\n```js\nconst n = 1;\n```\n\nhttps://example.com", "report");
    expect(html).toContain('<main class="markdown-body">');
    expect(html).toContain('<h1 id="user-content-report">Report</h1>');
    expect(html).toContain("<table>");
    expect(html).toContain("<td>one</td>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked');
    expect(html).toContain('disabled');
    expect(html).toContain("<del>old</del>");
    expect(html).toContain('class="language-js"');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("prefers-color-scheme: dark");
  });

  it("makes duplicate headings unique, keeps fragment links working, and isolates documents", () => {
    const source = "# Hello World\n\n# Hello World\n\n[Jump](#hello-world)";
    const html = renderMarkdown(source, "report");
    expect(html).toContain('id="user-content-hello-world"');
    expect(html).toContain('id="user-content-hello-world-1"');
    expect(html).toContain('href="#user-content-hello-world"');
    expect(renderMarkdown(source, "report")).toBe(html);
  });

  it("removes active HTML, dangerous links, event handlers, and document injection", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src="https://example.com/x.png" onerror="alert(1)">\n\n[bad](javascript:alert%281%29)\n\n<iframe src="https://evil.example"></iframe>\n\n<form><input type="text" onfocus="alert(1)"></form>', '</title><script>alert(2)</script>');
    const body = html.slice(html.indexOf('<main'));
    expect(body).not.toMatch(/<script|<iframe|<form|onerror|onfocus|javascript:/i);
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;");
    expect(body).toContain('src="https://example.com/x.png"');
    expect(body).toContain('type="checkbox" disabled');
  });

  it("preserves code literally without executing embedded HTML", () => {
    const html = renderMarkdown('```html\n<script>alert(1)</script>\n```', "code");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });
});
