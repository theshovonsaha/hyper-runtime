/**
 * knowledge/knowledge.ts — markdown knowledge substrate (soul + wiki), ported from
 * knowledge.py. This is the "self development tool": the agent's own
 * identity/behavior doc plus a linked wiki of pages it writes and reads back
 * over time, navigated like Anthropic's just-in-time retrieval guidance
 * (load the page you need, follow [[links]], don't pre-load everything).
 *
 * Uses async fs (node:fs/promises) for non-blocking I/O.
 * Framework-agnostic on purpose — `knowledgeTools()` returns plain
 * `{name, description, parameters, handler}` objects. Wrap each one into
 * your actual `Tool` constructor the same way mcp_client.py's `_wrap()`
 * does for MCP tools.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const WIKILINK = /\[\[([^\]]+)\]\]/g;
const TOKEN = /[a-z0-9]{3,}/g;

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

export interface WikiReadResult {
  exists: boolean;
  title: string;
  content?: string;
  links?: string[];
  backlinks?: string[];
  hint?: string;
}

export class MarkdownKnowledgeAsync {
  private wikiDir: string;
  private soulPath: string;

  constructor(private root: string) {
    this.wikiDir = path.join(root, 'wiki');
    this.soulPath = path.join(root, 'soul.md');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.wikiDir, { recursive: true });
  }

  // ---- soul (always-loaded identity) ----

  async soul(): Promise<string> {
    try {
      return await fs.readFile(this.soulPath, 'utf-8');
    } catch {
      return DEFAULT_SOUL;
    }
  }

  async setSoul(text: string): Promise<void> {
    await fs.writeFile(this.soulPath, text.slice(0, 8000), 'utf-8');
  }

  // ---- wiki (linked knowledge pages) ----

  private pagePath(title: string): string {
    return path.join(this.wikiDir, `${slug(title)}.md`);
  }

  static linksIn(text: string): string[] {
    const out = new Set<string>();
    for (const m of (text || '').matchAll(WIKILINK)) out.add(m[1].trim());
    return [...out].sort();
  }

  async wikiList(): Promise<string[]> {
    await this.init();
    const files = await fs.readdir(this.wikiDir);
    return files.filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).sort();
  }

  async wikiRead(title: string): Promise<WikiReadResult> {
    const p = this.pagePath(title);
    try {
      const content = await fs.readFile(p, 'utf-8');
      const stem = path.basename(p, '.md');
      return {
        exists: true,
        title: stem,
        content,
        links: MarkdownKnowledgeAsync.linksIn(content),
        backlinks: await this.backlinks(stem),
      };
    } catch {
      const existing = await this.wikiList();
      return {
        exists: false,
        title: slug(title),
        hint: `no page '${slug(title)}'. Existing pages: ${existing.length ? existing.join(', ') : '(none yet)'}`,
      };
    }
  }

  async wikiWrite(title: string, content: string, append = false): Promise<{ title: string; chars: number; links: string[] }> {
    const p = this.pagePath(title);
    let finalContent = content;
    if (append) {
      try {
        const existing = (await fs.readFile(p, 'utf-8')).replace(/\s+$/, '');
        finalContent = existing + '\n\n' + content;
      } catch {
        // no existing page — write fresh
      }
    }
    finalContent = finalContent.slice(0, 20000);
    await this.init();
    await fs.writeFile(p, finalContent, 'utf-8');
    return { title: path.basename(p, '.md'), chars: finalContent.length, links: MarkdownKnowledgeAsync.linksIn(finalContent) };
  }

  async wikiSearch(query: string, limit = 6): Promise<string[]> {
    const terms = new Set((query || '').toLowerCase().match(TOKEN) || []);
    await this.init();
    const files = (await fs.readdir(this.wikiDir)).filter(f => f.endsWith('.md'));
    const scored: Array<[number, string]> = [];
    for (const f of files) {
      const stem = f.slice(0, -3);
      const text = (await fs.readFile(path.join(this.wikiDir, f), 'utf-8')).toLowerCase();
      let score = 0;
      for (const t of terms) {
        const matches = text.split(t).length - 1;
        score += matches;
      }
      const titleBonus = 3 * [...terms].filter(t => stem.toLowerCase().includes(t)).length;
      if (score + titleBonus > 0) scored.push([score + titleBonus, stem]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, limit).map(([, t]) => t);
  }

  async backlinks(title: string): Promise<string[]> {
    await this.init();
    const files = (await fs.readdir(this.wikiDir)).filter(f => f.endsWith('.md'));
    const out: string[] = [];
    for (const f of files) {
      const stem = f.slice(0, -3);
      if (stem === slug(title)) continue;
      const text = await fs.readFile(path.join(this.wikiDir, f), 'utf-8');
      if (MarkdownKnowledgeAsync.linksIn(text).some(l => slug(l) === slug(title))) out.push(stem);
    }
    return out.sort();
  }

  async wikiDelete(title: string): Promise<boolean> {
    try {
      await fs.unlink(this.pagePath(title));
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Tool definitions — framework-agnostic; wrap into your real Tool type.
// ---------------------------------------------------------------------------

export interface PlainTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

export function knowledgeTools(knowledge: MarkdownKnowledgeAsync): PlainTool[] {
  return [
    {
      name: 'wiki_read',
      description: 'Read a page from your own knowledge wiki by title. Follow [[links]] you find by reading those pages too.',
      parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      handler: async (args) => JSON.stringify(await knowledge.wikiRead(String(args.title || ''))),
    },
    {
      name: 'wiki_write',
      description: 'Write or append to a page in your own knowledge wiki. Use [[Page Title]] to link related pages.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
          append: { type: 'boolean', description: 'Append to the existing page instead of replacing it.' },
        },
        required: ['title', 'content'],
      },
      handler: async (args) => JSON.stringify(await knowledge.wikiWrite(
        String(args.title || ''), String(args.content || ''), Boolean(args.append),
      )),
    },
    {
      name: 'wiki_search',
      description: 'Search your knowledge wiki for pages relevant to a query.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      handler: async (args) => JSON.stringify(await knowledge.wikiSearch(String(args.query || ''))),
    },
    {
      name: 'wiki_list',
      description: 'List every page currently in your knowledge wiki.',
      parameters: { type: 'object', properties: {} },
      handler: async () => JSON.stringify(await knowledge.wikiList()),
    },
  ];
}
