const { escapeText, escapeAttr, decodeText, safeHttpUrl } = require('./htmlUtils');

const KEYWORDS =
  'const|let|var|function|return|if|else|for|while|class|import|from|export|default|async|await|new|this|try|catch|finally|throw|typeof|instanceof|in|of|null|undefined|true|false|switch|case|break|continue|do|extends|super|static|yield|delete|void|interface|type|enum|implements|public|private|readonly';

const HIGHLIGHTED_LANGUAGES = new Set([
  '',
  'js',
  'jsx',
  'javascript',
  'ts',
  'tsx',
  'typescript',
  'json',
  'mjs',
  'cjs'
]);

const FENCE = /^\s*(```+|~~~+)\s*([\w+-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HTML_HEADING = /^\s*<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>\s*$/i;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const MAX_LIST_DEPTH = 3;
const PLACEHOLDER = /\u0001(\d+)\u0001/g;

class MarkdownRenderer {
  render(markdown) {
    if (!markdown) return '';
    const source = String(markdown)
      .replace(/\u0001/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/<!--[\s\S]*?-->/g, '');
    return this._renderBlocks(source.split('\n'));
  }

  _renderBlocks(lines) {
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      const fence = line.match(FENCE);
      if (fence) {
        const code = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence[1])) {
          code.push(lines[i]);
          i++;
        }
        i++;
        out.push(this._codeBlock(code.join('\n'), fence[2].toLowerCase()));
        continue;
      }

      if (!line.trim()) {
        i++;
        continue;
      }

      const htmlHeading = line.match(HTML_HEADING);
      if (htmlHeading) {
        out.push(this._heading(htmlHeading[1].length, htmlHeading[2]));
        i++;
        continue;
      }

      const heading = line.match(HEADING);
      if (heading) {
        out.push(this._heading(heading[1].length, heading[2]));
        i++;
        continue;
      }

      if (RULE.test(line)) {
        out.push('<hr>');
        i++;
        continue;
      }

      if (QUOTE.test(line)) {
        const quoted = [];
        while (i < lines.length && QUOTE.test(lines[i])) {
          quoted.push(lines[i].replace(QUOTE, ''));
          i++;
        }
        out.push(`<blockquote>${this._renderBlocks(quoted)}</blockquote>`);
        continue;
      }

      if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
        const rows = [line];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          rows.push(lines[i]);
          i++;
        }
        out.push(this._table(rows));
        continue;
      }

      if (LIST_ITEM.test(line)) {
        const items = [];
        while (i < lines.length && LIST_ITEM.test(lines[i])) {
          items.push(lines[i]);
          i++;
        }
        out.push(this._list(items));
        continue;
      }

      const paragraph = [];
      while (i < lines.length && lines[i].trim() && !this._startsBlock(lines[i])) {
        paragraph.push(lines[i].trim());
        i++;
      }
      const inline = this._inline(paragraph.join(' '));
      if (inline.trim()) out.push(`<p>${inline}</p>`);
    }

    return out.join('\n');
  }

  _startsBlock(line) {
    return (
      FENCE.test(line) ||
      HEADING.test(line) ||
      HTML_HEADING.test(line) ||
      RULE.test(line) ||
      QUOTE.test(line) ||
      LIST_ITEM.test(line)
    );
  }

  _heading(level, text) {
    const inline = this._inline(text);
    return inline.trim() ? `<h${level}>${inline}</h${level}>` : '';
  }

  _list(lines) {
    const ordered = /^\s*\d/.test(lines[0]);
    const tag = ordered ? 'ol' : 'ul';
    const items = lines.map((line) => {
      const match = line.match(LIST_ITEM);
      const depth = Math.min(Math.floor(match[1].replace(/\t/g, '    ').length / 2), MAX_LIST_DEPTH);
      return `<li class="depth-${depth}">${this._inline(match[3])}</li>`;
    });
    return `<${tag}>${items.join('')}</${tag}>`;
  }

  _table(rows) {
    const cells = (row) =>
      row
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim());

    const [head, ...body] = rows;
    const headHtml = cells(head)
      .map((cell) => `<th>${this._inline(cell)}</th>`)
      .join('');
    const bodyHtml = body
      .map((row) => `<tr>${cells(row).map((cell) => `<td>${this._inline(cell)}</td>`).join('')}</tr>`)
      .join('');
    return `<table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
  }

  _codeBlock(code, language) {
    const escaped = escapeText(code);
    const body = HIGHLIGHTED_LANGUAGES.has(language) ? this._highlightCode(escaped) : escaped;
    return `<pre><code>${body}</code></pre>`;
  }

  _decodeEntities(text) {
    const named = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", copy: '©', mdash: '—', ndash: '–', hellip: '…' };
    return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (match, dec, hex, name) => {
      if (name) return named[name.toLowerCase()] ?? match;
      const code = dec ? Number(dec) : parseInt(hex, 16);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    });
  }

  _htmlAttribute(tag, name) {
    const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
    return match ? match[1] || match[2] || '' : '';
  }

  _inline(text) {
    const store = [];
    const keep = (html) => {
      store.push(html);
      return `\u0001${store.length - 1}\u0001`;
    };

    let s = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, __, code) =>
      keep(`<code>${escapeText(code.trim())}</code>`)
    );

    s = s.replace(/<(https?:\/\/[^>\s]+)>/g, '[$1]($1)');
    s = s.replace(/<img\b[^>]*>/gi, (tag) => {
      const src = this._htmlAttribute(tag, 'src');
      const alt = this._htmlAttribute(tag, 'alt').replace(/[[\]()]/g, '');
      return src ? `![${alt}](${src})` : '';
    });
    s = s.replace(
      /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi,
      (_, double, single, inner) => `[${inner}](${double || single})`
    );
    s = s.replace(/<br\s*\/?>/gi, ' ').replace(/<\/?[a-zA-Z][^>]*>/g, '');

    s = escapeText(this._decodeEntities(s));

    s = s.replace(/!\[([^\]]*)\]\(\s*([^\s)]+)[^)]*\)/g, (_, alt, rawUrl) => {
      const url = safeHttpUrl(decodeText(rawUrl));
      const cleanAlt = decodeText(alt).replace(PLACEHOLDER, '');
      if (!url) return cleanAlt ? escapeText(cleanAlt) : '';
      return keep(`<img src="${escapeAttr(url)}" alt="${escapeAttr(cleanAlt)}">`);
    });

    s = s.replace(
      /\[((?:[^[\]]|\u0001\d+\u0001)+)\]\(\s*([^\s)]+)[^)]*\)/g,
      (_, label, rawUrl) => {
        const url = safeHttpUrl(decodeText(rawUrl));
        if (!url) return label;
        return keep(
          `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
        );
      }
    );

    s = s
      .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<b>${a || b}</b>`)
      .replace(/~~(.+?)~~/g, '<del>$1</del>')
      .replace(
        /(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])/g,
        (_, a, b) => `<i>${a || b}</i>`
      );

    let restored = s;
    for (let pass = 0; pass < 3 && restored.includes('\u0001'); pass++) {
      restored = restored.replace(PLACEHOLDER, (_, index) => store[Number(index)]);
    }
    return restored;
  }

  _highlightCode(code) {
    const pattern = new RegExp(
      `(\\/\\/.*$)|(\\/\\*[\\s\\S]*?\\*\\/)|('(?:[^'\\\\\\n]|\\\\.)*'|"(?:[^"\\\\\\n]|\\\\.)*"|\`(?:[^\`\\\\]|\\\\.)*\`)|\\b(${KEYWORDS})\\b|\\b(\\d+(?:\\.\\d+)?)\\b`,
      'gm'
    );

    return code.replace(pattern, (match, comment, blockComment, string, keyword, number) => {
      if (comment || blockComment) return `<span class="tok-comment">${match}</span>`;
      if (string) return `<span class="tok-string">${match}</span>`;
      if (keyword) return `<span class="tok-keyword">${match}</span>`;
      if (number) return `<span class="tok-number">${match}</span>`;
      return match;
    });
  }
}

module.exports = { MarkdownRenderer };
