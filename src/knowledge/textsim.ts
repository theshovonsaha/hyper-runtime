/**
 * Near-duplicate text detection for evolving memory.
 * 
 * Ported from textsim.py
 */

const _TOKEN_RE = /[a-z0-9]{2,}/g;
const _STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'be', 'but', 'by', 'for', 'if', 'in', 'is',
  'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'were', 'will', 'with'
]);

function getTokens(text: string): string[] {
  const out: string[] = [];
  const matches = (text || '').toLowerCase().match(_TOKEN_RE) || [];
  
  for (let tok of matches) {
    if (_STOPWORDS.has(tok)) continue;
    
    // crude plural fold
    if (tok.length > 3 && tok.endsWith('s') && !tok.endsWith('ss')) {
      tok = tok.slice(0, -1);
    }
    out.push(tok);
  }
  return out;
}

export function similarity(a: string, b: string): number {
  const ta = getTokens(a);
  const tb = getTokens(b);
  
  if (ta.length === 0 || tb.length === 0) {
    return ta.join('') === tb.join('') ? 1.0 : 0.0;
  }
  
  let sa = new Set<string>();
  let sb = new Set<string>();
  
  if (ta.length < 3 || tb.length < 3) {
    sa = new Set(ta);
    sb = new Set(tb);
  } else {
    for (let i = 0; i < ta.length - 1; i++) sa.add(ta[i] + '_' + ta[i+1]);
    for (let i = 0; i < tb.length - 1; i++) sb.add(tb[i] + '_' + tb[i+1]);
  }
  
  let inter = 0;
  for (const item of sa) {
    if (sb.has(item)) inter++;
  }
  
  const unionSize = sa.size + sb.size - inter;
  return unionSize > 0 ? inter / unionSize : 0.0;
}

export function nearDuplicate(a: string, b: string, threshold = 0.82): boolean {
  return similarity(a, b) >= threshold;
}
