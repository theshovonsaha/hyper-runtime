import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { Glob } from 'bun';

const _WIKILINK = /\[\[([^\]]+)\]\]/g;
const _TOKEN = /[a-z0-9]{3,}/g;

export const DEFAULT_SOUL = `# Soul

You are Shovs — a transparent, honest agent. You value:
- **Clarity over cleverness.** Say what is true, plainly, including when you cannot do something.
- **Grounding over guessing.** Prefer tool evidence; never fabricate.
- **The user's steering.** Your context and memory are theirs to inspect and edit.

Edit this file to shape standing behavior. It is always in context.
`;

function slug(title: string): string {
  const s = (title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 80) || 'untitled';
}

export interface WikiPageResult {
  exists: boolean;
  title: string;
  content: string;
  links: string[];
  backlinks: string[];
  hint?: string;
}

export interface WikiWriteResult {
  title: string;
  chars: number;
  links: string[];
}

export class MarkdownKnowledge {
  private wikiDir: string;
  private soulPath: string;

  constructor(private root: string) {
    this.wikiDir = join(root, 'wiki');
    mkdirSync(this.wikiDir, { recursive: true });
    this.soulPath = join(root, 'soul.md');
  }

  // ---- soul (always-loaded identity) --------------------------------

  soul(): string {
    if (existsSync(this.soulPath)) {
      return readFileSync(this.soulPath, 'utf-8');
    }
    return DEFAULT_SOUL;
  }

  setSoul(text: string): void {
    writeFileSync(this.soulPath, text.slice(0, 8000), 'utf-8');
  }

  // ---- wiki (linked knowledge pages) --------------------------------

  private pagePath(title: string): string {
    return join(this.wikiDir, `${slug(title)}.md`);
  }

  static linksIn(text: string): string[] {
    if (!text) return [];
    const links = new Set<string>();
    let match;
    // reset regex index
    _WIKILINK.lastIndex = 0;
    while ((match = _WIKILINK.exec(text)) !== null) {
      links.add(match[1].trim());
    }
    return Array.from(links).sort();
  }

  wikiList(): string[] {
    const glob = new Glob('*.md');
    const files = Array.from(glob.scanSync({ cwd: this.wikiDir }));
    return files.map(f => f.replace(/\.md$/, '')).sort();
  }

  wikiRead(title: string): WikiPageResult {
    const path = this.pagePath(title);
    const pageSlug = slug(title);
    if (!existsSync(path)) {
      const existing = this.wikiList();
      return {
        exists: false,
        title: pageSlug,
        content: '',
        links: [],
        backlinks: [],
        hint: `no page '${pageSlug}'. Existing pages: ` +
          (existing.length > 0 ? existing.join(', ') : '(none yet)'),
      };
    }
    const content = readFileSync(path, 'utf-8');
    return {
      exists: true,
      title: pageSlug,
      content,
      links: MarkdownKnowledge.linksIn(content),
      backlinks: this.backlinks(pageSlug),
    };
  }

  wikiWrite(title: string, content: string, append = false): WikiWriteResult {
    const path = this.pagePath(title);
    let finalContent = content;
    if (append && existsSync(path)) {
      finalContent = readFileSync(path, 'utf-8').trimEnd() + '\n\n' + content;
    }
    writeFileSync(path, finalContent.slice(0, 20000), 'utf-8');
    return {
      title: slug(title),
      chars: finalContent.length,
      links: MarkdownKnowledge.linksIn(finalContent),
    };
  }

  wikiSearch(query: string, limit = 6): string[] {
    const queryLower = (query || '').toLowerCase();
    const terms = new Set(queryLower.match(_TOKEN) || []);
    if (terms.size === 0) return [];

    const scored: Array<[number, string]> = [];
    const glob = new Glob('*.md');
    
    for (const file of glob.scanSync({ cwd: this.wikiDir })) {
      const path = join(this.wikiDir, file);
      const text = readFileSync(path, 'utf-8').toLowerCase();
      const pageTitle = file.replace(/\.md$/, '');
      
      let score = 0;
      for (const t of terms) {
        // count occurrences
        let idx = text.indexOf(t);
        while (idx !== -1) {
          score++;
          idx = text.indexOf(t, idx + 1);
        }
      }
      
      let titleBonus = 0;
      for (const t of terms) {
        if (pageTitle.toLowerCase().includes(t)) {
          titleBonus += 3;
        }
      }
      
      if (score + titleBonus > 0) {
        scored.push([score + titleBonus, pageTitle]);
      }
    }

    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, limit).map(x => x[1]);
  }

  backlinks(title: string): string[] {
    const pageSlug = slug(title);
    const out: string[] = [];
    const glob = new Glob('*.md');
    
    for (const file of glob.scanSync({ cwd: this.wikiDir })) {
      const pageTitle = file.replace(/\.md$/, '');
      if (slug(pageTitle) === pageSlug) continue;
      
      const path = join(this.wikiDir, file);
      const content = readFileSync(path, 'utf-8');
      const links = MarkdownKnowledge.linksIn(content);
      
      if (links.some(l => slug(l) === pageSlug)) {
        out.push(pageTitle);
      }
    }
    
    return out.sort();
  }

  wikiDelete(title: string): boolean {
    const path = this.pagePath(title);
    if (existsSync(path)) {
      const fs = require('fs');
      fs.unlinkSync(path);
      return true;
    }
    return false;
  }
}
