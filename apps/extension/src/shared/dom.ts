type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | EventListener | null | undefined>;

/**
 * Tiny element factory. Text always goes through text nodes — never innerHTML — so
 * server-provided strings (captions, names) cannot inject markup.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith("on") && typeof value === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === "class") {
        el.className = String(value);
      } else if (value === true) {
        el.setAttribute(key, "");
      } else {
        el.setAttribute(key, String(value));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(
      typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c,
    );
  }
}

export function replaceChildren(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}

/**
 * Renders the small Markdown subset used by the consent documents (paragraphs, `**bold**`,
 * numbered and bulleted lists) into DOM nodes. The documents are rendered exactly as
 * shipped in @ltm/protocol, never rewritten.
 */
export function renderMarkdown(md: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const blocks = md.split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;
    if (lines.every((l) => /^\d+\.\s/.test(l))) {
      const ol = h("ol");
      for (const l of lines) ol.appendChild(inline(h("li"), l.replace(/^\d+\.\s/, "")));
      frag.appendChild(ol);
    } else if (lines.every((l) => /^[-*]\s/.test(l))) {
      const ul = h("ul");
      for (const l of lines) ul.appendChild(inline(h("li"), l.replace(/^[-*]\s/, "")));
      frag.appendChild(ul);
    } else {
      frag.appendChild(inline(h("p"), lines.join(" ")));
    }
  }
  return frag;
}

function inline<T extends HTMLElement>(el: T, text: string): T {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      el.appendChild(h("strong", null, part.slice(2, -2)));
    } else if (part) {
      el.appendChild(document.createTextNode(part));
    }
  }
  return el;
}
