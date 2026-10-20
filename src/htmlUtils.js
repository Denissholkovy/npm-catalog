function escapeText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return escapeText(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function decodeText(value) {
  return String(value).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function safeHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

module.exports = { escapeText, escapeAttr, decodeText, safeHttpUrl };
