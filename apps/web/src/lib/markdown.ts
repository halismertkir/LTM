import DOMPurify from "dompurify";
import { Marked } from "marked";

// Notes, answers and consent texts are markdown written by a language model or the user.
// Everything goes through DOMPurify before it touches the DOM.
const marked = new Marked({ gfm: true, breaks: false, async: false });

let hooked = false;
function purifier() {
  if (!hooked) {
    hooked = true;
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A") {
        const href = node.getAttribute("href") ?? "";
        if (!href.startsWith("#") && !href.startsWith("/")) {
          node.setAttribute("target", "_blank");
          // no-referrer: never leak the dashboard URL to whatever a note links to.
          node.setAttribute("rel", "noopener noreferrer nofollow");
        }
      }
    });
  }
  return DOMPurify;
}

export function renderMarkdown(src: string): string {
  const html = marked.parse(src) as string;
  return purifier().sanitize(html, {
    USE_PROFILES: { html: true },
    // Remote images would be fetched by the browser — a tracking pixel in generated notes
    // would leak that the user opened them. LTM makes zero third-party requests.
    FORBID_TAGS: ["img", "picture", "video", "audio", "source", "iframe", "form", "input", "style"],
    FORBID_ATTR: ["style", "srcset"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|\/)/i,
  });
}

/** Turn `[3]` citation markers into in-page links to `#cite-3` before rendering. */
export function linkCitations(markdown: string, count: number): string {
  return markdown.replace(/\[(\d{1,3})\](?!\(|:)/g, (m, n: string) => {
    const i = Number(n);
    return i >= 1 && i <= count ? `[\\[${i}\\]](#cite-${i})` : m;
  });
}
