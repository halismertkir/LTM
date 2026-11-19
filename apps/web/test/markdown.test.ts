import { describe, expect, it } from "vitest";
import { linkCitations, renderMarkdown } from "../src/lib/markdown";

describe("markdown rendering", () => {
  it("strips scripts, event handlers, remote images and javascript: links", () => {
    const html = renderMarkdown(
      '# Hi\n\n<script>alert(1)</script><img src=x onerror=alert(2)> [x](javascript:alert(3)) <a href="https://example.test" onclick="x()">ok</a>',
    );
    expect(html).toContain("<h1>Hi</h1>");
    expect(html).not.toMatch(/<script|onerror|onclick|<img|href="javascript:/i);
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it("turns citation markers into in-page links only for existing citations", () => {
    expect(linkCitations("A [1] and [2], not [7] or [x](y)", 2)).toBe(
      "A [\\[1\\]](#cite-1) and [\\[2\\]](#cite-2), not [7] or [x](y)",
    );
    expect(renderMarkdown(linkCitations("See [1].", 1))).toContain('href="#cite-1"');
  });
});
