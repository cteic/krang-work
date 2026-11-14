// Markdown to HTML for the read-only web page: headings, paragraphs, lists,
// task boxes, quotes, fenced code, tables, and inline code, bold, italic and
// links. Small on purpose, and safe by construction: every character of the
// source is escaped before any tag is added, the only attribute ever written
// is an href, and an href is only written for an http or https address.
// Anything it does not understand comes out as the escaped text it was.

function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inline(source: string): string {
  // Code spans are lifted out first so nothing inside them is styled.
  const spans: string[] = [];
  let text = escape(source.replaceAll("\uE000", "")).replace(
    /`([^`]+)`/g,
    (_match, code: string) => {
      spans.push(`<code>${code}</code>`);
      return `\uE000${spans.length - 1}\uE000`;
    },
  );
  text = text
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt: string) => `[image: ${alt}]`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" rel="noreferrer">$2</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
  // The escaped quotes inside an href came from the source, never from here.
  return text.replace(/\uE000(\d+)\uE000/g, (_match, index: string) => spans[Number(index)] ?? "");
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      out.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flush();
      // A document heading sits under the page's own h1 and section h2.
      const level = Math.min(6, heading[1].length + 2);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flush();
      out.push("<hr>");
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const quote: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
      }
      i--;
      out.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      flush();
      const head = cells(line);
      const rows: string[] = [];
      for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim() !== ""; i++) {
        rows.push(
          `<tr>${cells(lines[i])
            .map((cell) => `<td>${inline(cell)}</td>`)
            .join("")}</tr>`,
        );
      }
      i--;
      out.push(
        `<table><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr>${rows.join("")}</table>`,
      );
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item !== null) {
      flush();
      const ordered = /\d/.test(item[2]);
      const items: string[] = [];
      for (; i < lines.length; i++) {
        const next = LIST_ITEM.exec(lines[i]);
        if (next === null) {
          // An indented line continues the item above it.
          if (lines[i].trim() !== "" && /^\s+/.test(lines[i]) && items.length > 0) {
            items[items.length - 1] += `<br>${inline(lines[i].trim())}`;
            continue;
          }
          break;
        }
        const box = /^\[([ xX])\]\s+(.*)$/.exec(next[3]);
        const depth = Math.min(4, Math.floor(next[1].length / 2));
        const body =
          box === null ? inline(next[3]) : `${box[1] === " " ? "☐" : "☑"} ${inline(box[2])}`;
        items.push(`<li class="d${depth}">${body}`);
      }
      i--;
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((entry) => `${entry}</li>`).join("")}</${tag}>`);
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return out.join("\n");
}
