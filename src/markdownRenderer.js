const KEYWORDS =
  'const|let|var|function|return|if|else|for|while|class|import|from|export|default|async|await|new|this|try|catch|finally|throw|typeof|instanceof|in|of|null|undefined|true|false|switch|case|break|continue|do|extends|super|static|yield|delete|void';

class MarkdownRenderer {
  render(markdown) {
    if (!markdown) return '';

    const codeBlocks = [];
    let text = markdown.replace(/```[\s\S]*?```/g, (block) => {
      const code = block.replace(/```(\w*)\n?/, '').replace(/```$/, '');
      const html = `<pre><code>${this._highlightCode(this._escapeHtml(code))}</code></pre>`;
      codeBlocks.push(html);
      return `\u0000CODEBLOCK${codeBlocks.length - 1}\u0000`;
    });

    text = this._sanitizeHtml(text);
    text = this._applyHeadings(text);
    text = this._applyInlineStyles(text);
    text = this._applyLinks(text);
    text = this._wrapParagraphs(text);

    return text.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, i) => codeBlocks[Number(i)]);
  }

  _escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  _sanitizeHtml(html) {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
      .replace(/\son\w+\s*=\s*"(?:[^"\\]|\\.)*"/gi, '')
      .replace(/\son\w+\s*=\s*'(?:[^'\\]|\\.)*'/gi, '')
      .replace(/javascript:/gi, '');
  }

  _highlightCode(code) {
    const pattern = new RegExp(
      `(\\/\\/.*$)|(\\/\\*[\\s\\S]*?\\*\\/)|('(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*"|\`(?:[^\`\\\\]|\\\\.)*\`)|\\b(${KEYWORDS})\\b|\\b(\\d+(?:\\.\\d+)?)\\b`,
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

  _applyHeadings(text) {
    return text
      .replace(/^### (.*)$/gm, '<h3>$1</h3>')
      .replace(/^## (.*)$/gm, '<h2>$1</h2>')
      .replace(/^# (.*)$/gm, '<h1>$1</h1>');
  }

  _applyInlineStyles(text) {
    text = text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    text = text.replace(/`([^`]+)`/g, (_, inline) => `<code>${this._escapeHtml(inline)}</code>`);
    return text;
  }

  _applyLinks(text) {
    return text.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
  }

  _wrapParagraphs(text) {
    return text
      .split(/\n{2,}/)
      .map((paragraph) => {
        const trimmed = paragraph.trim();
        if (!trimmed) return '';
        if (trimmed.startsWith('<') || trimmed.startsWith('\u0000CODEBLOCK')) return paragraph;
        return `<p>${paragraph}</p>`;
      })
      .join('\n');
  }
}

module.exports = { MarkdownRenderer };
