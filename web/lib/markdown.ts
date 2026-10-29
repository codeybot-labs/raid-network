// Tiny, safe markdown → HTML for assistant replies. Everything is HTML-escaped first; only a small
// whitelist of constructs is re-introduced (bold, italic, code, links to http(s) or same-site paths, lists, paragraphs).
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function inline(s: string): string {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^\s)]+)\)/g, (_m, label: string, href: string) => {
    const ext = href.startsWith('http');
    return `<a href="${href}"${ext ? ' target="_blank" rel="noreferrer noopener"' : ''}>${label}</a>`;
  });
  return t;
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r/g, '').split('\n');
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let para: string[] = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const h = /^\s*#{1,4}\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline((ul ?? ol)![1])}</li>`);
    } else if (h) {
      flushPara(); closeList(); out.push(`<p class="md-h">${inline(h[1])}</p>`);
    } else if (!line.trim()) {
      flushPara(); closeList();
    } else {
      closeList(); para.push(line);
    }
  }
  flushPara(); closeList();
  return out.join('');
}
