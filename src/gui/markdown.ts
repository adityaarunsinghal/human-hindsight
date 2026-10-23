import DOMPurify from "dompurify";
import { Marked } from "marked";

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (value) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[value] ?? value,
  );
const markdown = new Marked({
  gfm: true,
  renderer: {
    // Prompt XML/HTML is instruction text, never active page content.
    html: ({ text }) => escapeHtml(text),
    // Viewing a local library must not fetch tracking pixels or remote assets.
    image: ({ text }) =>
      `<span class="attachment">[Image${text ? `: ${escapeHtml(text)}` : ""}]</span>`,
  },
});

export function renderMarkdown(source: string): DocumentFragment {
  const fragment = DOMPurify.sanitize(markdown.parse(source, { async: false }), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: [
      "p",
      "br",
      "hr",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "strong",
      "em",
      "del",
      "a",
      "ul",
      "ol",
      "li",
      "blockquote",
      "pre",
      "code",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "input",
      "span",
    ],
    ALLOWED_ATTR: ["href", "title", "class", "start", "align", "type", "checked", "disabled"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  const headings = new Set<string>();
  for (const heading of fragment.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
    const base =
      (heading.textContent ?? "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .trim()
        .replace(/\s+/g, "-") || "section";
    let slug = base;
    for (let i = 2; headings.has(slug); i++) slug = `${base}-${i}`;
    headings.add(slug);
    heading.id = `prompt-${slug}`;
  }
  for (const link of fragment.querySelectorAll("a")) {
    const href = link.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        try {
          document
            .getElementById(`prompt-${decodeURIComponent(href.slice(1))}`)
            ?.scrollIntoView({ block: "start" });
        } catch {
          /* An invalid fragment is just text. */
        }
      });
      continue;
    }
    try {
      const url = new URL(href);
      if (!["https:", "http:", "mailto:"].includes(url.protocol))
        throw new Error("Unsupported link");
      link.href = url.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    } catch {
      link.removeAttribute("href");
    }
  }
  for (const input of fragment.querySelectorAll("input")) {
    // Only inert task-list checkboxes belong in a prompt preview.
    if (input.type !== "checkbox") input.remove();
    else input.disabled = true;
  }
  for (const code of fragment.querySelectorAll("pre > code")) {
    const language = [...code.classList].find((value) => value.startsWith("language-"))?.slice(9);
    if (language && /^[\w+-]{1,30}$/.test(language))
      code.parentElement?.setAttribute("data-language", language);
    code.parentElement?.setAttribute("tabindex", "0");
  }
  return fragment;
}
