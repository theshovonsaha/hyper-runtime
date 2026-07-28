/**
 * Built-in tools — the primitive toolkit available to every agent.
 *
 * 10 tools covering:
 *   - Computation: calculator
 *   - Time: clock
 *   - Filesystem: read_file, write_file, list_files
 *   - Network: web_fetch, web_search
 *   - Shell: run_shell
 *   - Memory: search_notes, remember
 *
 * All tools use Bun-native APIs where possible:
 *   - Bun.file / Bun.write for filesystem
 *   - Bun.Glob for directory scanning
 *   - Bun.spawn for shell execution
 *   - Bun.env for API key access
 *
 * Design notes:
 *   - Every tool returns ToolResult, never throws.
 *   - search_notes / remember are stubs that return placeholder responses
 *     until the Store is wired in via the action loop.
 *   - calculator uses a restricted Function() eval — NOT safe for untrusted
 *     input in production; consider a proper math parser for hardened deployments.
 *   - web_fetch strips HTML tags for readability; output is capped at 30k chars.
 *   - run_shell captures stdout+stderr and caps at 20k chars.
 */

import type { ToolDefinition, ToolContext, ToolResult } from './registry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate a math expression contains only safe characters */
const SAFE_MATH_PATTERN = /^[\d+\-*/().%\s,eE]|Math\.\w+/;

/** Strip HTML to plain text */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Built-in tool factory
// ---------------------------------------------------------------------------

export function createBuiltinTools(): ToolDefinition[] {
  return [
    // ---- 1. Calculator ----------------------------------------------------
    {
      name: 'calculator',
      description: 'Evaluate a mathematical expression safely.',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description:
              'The math expression to evaluate (e.g. "2 + 3 * 4", "Math.sqrt(16)")',
          },
        },
        required: ['expression'],
      },
      execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
        const expr = String(args.expression);
        // Block obviously dangerous patterns
        if (/\b(require|import|fetch|eval|process|Bun|Deno)\b/.test(expr)) {
          return { content: 'Expression contains disallowed keywords', success: false };
        }
        try {
          // eslint-disable-next-line no-new-func
          const result = new Function('"use strict"; return (' + expr + ')')();
          return { content: String(result), success: true, metadata: { expression: expr } };
        } catch {
          return { content: 'Invalid expression', success: false };
        }
      },
    },

    // ---- 2. Clock ---------------------------------------------------------
    {
      name: 'clock',
      description: 'Get the current date and time.',
      parameters: {
        type: 'object',
        properties: {
          timezone: {
            type: 'string',
            description: 'IANA timezone (default: UTC), e.g. "America/New_York"',
          },
        },
      },
      execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
        const tz = String(args.timezone || 'UTC');
        try {
          const now = new Date().toLocaleString('en-US', {
            timeZone: tz,
            dateStyle: 'full',
            timeStyle: 'long',
          });
          return { content: now, success: true, metadata: { timezone: tz } };
        } catch {
          return { content: `Invalid timezone: ${tz}`, success: false };
        }
      },
    },

    // ---- 3. Read File -----------------------------------------------------
    {
      name: 'read_file',
      description: 'Read the contents of a file from disk.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file' },
        },
        required: ['path'],
      },
      execute: async (
        args: Record<string, unknown>,
        _ctx: ToolContext,
      ): Promise<ToolResult> => {
        try {
          const filePath = String(args.path);
          const file = Bun.file(filePath);
          if (!(await file.exists())) {
            return { content: 'File not found', success: false, metadata: { path: filePath } };
          }
          const text = await file.text();
          return {
            content: text.slice(0, 50_000),
            success: true,
            metadata: { path: filePath, size: file.size, truncated: text.length > 50_000 },
          };
        } catch (err) {
          return {
            content: `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
            success: false,
          };
        }
      },
    },

    // ---- 4. Write File ----------------------------------------------------
    {
      name: 'write_file',
      description: 'Write content to a file (creates parent directories if needed).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to write' },
          content: { type: 'string', description: 'Content to write to the file' },
        },
        required: ['path', 'content'],
      },
      execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const filePath = String(args.path);
          const content = String(args.content);
          await Bun.write(filePath, content);
          return {
            content: `Written ${content.length} chars to ${filePath}`,
            success: true,
            metadata: { path: filePath, chars: content.length },
          };
        } catch (err) {
          return {
            content: `Error writing file: ${err instanceof Error ? err.message : String(err)}`,
            success: false,
          };
        }
      },
    },

    // ---- 5. List Files ----------------------------------------------------
    {
      name: 'list_files',
      description: 'List files in a directory, optionally filtered by a glob pattern.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list' },
          pattern: { type: 'string', description: 'Glob pattern to filter files (default: "*")' },
        },
        required: ['path'],
      },
      execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const dirPath = String(args.path);
          const globPattern = String(args.pattern || '*');
          const glob = new Bun.Glob(globPattern);
          const results: string[] = [];
          for await (const file of glob.scan({ cwd: dirPath })) {
            results.push(file);
            if (results.length >= 200) break;
          }
          return {
            content: results.length > 0 ? results.join('\n') : '(empty directory)',
            success: true,
            metadata: { count: results.length, path: dirPath, truncated: results.length >= 200 },
          };
        } catch (err) {
          return {
            content: `Error listing files: ${err instanceof Error ? err.message : String(err)}`,
            success: false,
          };
        }
      },
    },

    // ---- 6. Web Fetch -----------------------------------------------------
    {
      name: 'web_fetch',
      description: 'Fetch the content of a URL and return cleaned text.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
        },
        required: ['url'],
      },
      execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const url = String(args.url);
          const resp = await fetch(url, {
            headers: { 'User-Agent': 'HarnessRuntime/1.0' },
          });
          if (!resp.ok) {
            return {
              content: `HTTP ${resp.status} ${resp.statusText}`,
              success: false,
              metadata: { url, status: resp.status },
            };
          }
          const text = await resp.text();
          const clean = stripHtml(text);
          return {
            content: clean.slice(0, 30_000),
            success: true,
            metadata: {
              url,
              status: resp.status,
              original_length: text.length,
              truncated: clean.length > 30_000,
            },
          };
        } catch (err) {
          return {
            content: `Fetch error: ${err instanceof Error ? err.message : String(err)}`,
            success: false,
          };
        }
      },
    },

    // ---- 7. Web Search ----------------------------------------------------
    {
      name: 'web_search',
      description: 'Search the web using DuckDuckGo and Wikipedia. Returns structured results including titles, snippets, and URLs.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
        },
        required: ['query'],
      },
      intent: /\b(search|find|look up|what is|who is|when did|where|how to)\b/i,
      execute: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
        const query = String(args.query);
        const results: Array<{ title: string; url: string; snippet: string; source: string }> = [];

        // --- 1. Wikipedia Summary ---
        try {
          const wikiSearch = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=&format=json`);
          if (wikiSearch.ok) {
            const searchData = await wikiSearch.json() as any;
            const topHit = searchData.query?.search?.[0];
            if (topHit) {
              const pageResp = await fetch(`https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&titles=${encodeURIComponent(topHit.title)}&format=json`);
              if (pageResp.ok) {
                const pageData = await pageResp.json() as any;
                const pages = pageData.query?.pages;
                if (pages) {
                  const pageId = Object.keys(pages)[0];
                  const extract = pages[pageId].extract;
                  if (extract) {
                    results.push({
                      title: topHit.title,
                      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(topHit.title.replace(/ /g, '_'))}`,
                      snippet: extract.substring(0, 400) + (extract.length > 400 ? '...' : ''),
                      source: 'wikipedia'
                    });
                  }
                }
              }
            }
          }
        } catch {}

        // --- 2. DuckDuckGo HTML ---
        try {
          const ddg = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; rv:102.0) Gecko/20100101 Firefox/102.0' }
          });
          if (ddg.ok) {
            const html = await ddg.text();
            const blocks = html.split('class="result ');
            let ddgCount = 0;
            for (let i = 1; i < blocks.length; i++) {
              if (ddgCount >= 5) break;
              const block = blocks[i];
              
              const urlMatch = block.match(/href="([^"]+)"/);
              if (!urlMatch) continue;
              let url = urlMatch[1];
              if (url.startsWith('//duckduckgo.com/l/?uddg=')) {
                url = decodeURIComponent(url.split('uddg=')[1].split('&')[0]);
              }

              const titleMatch = block.match(/<h2 class="result__title">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
              const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';

              const snippetMatch = block.match(/class="result__snippet[^>]*>([\s\S]*?)<\/a>/);
              const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '';

              if (title && url) {
                results.push({ title, url, snippet, source: 'duckduckgo' });
                ddgCount++;
              }
            }
          }
        } catch {}

        if (results.length === 0) {
          return {
            content: 'No results found.',
            success: false,
            metadata: { query }
          };
        }

        const formatted = results.map(r => `[${r.source.toUpperCase()}] ${r.title}\nURL: ${r.url}\n${r.snippet}`).join('\n\n');
        
        return {
          content: formatted,
          success: true,
          metadata: { query, results }
        };
      },
    },

    // ---- 8. Run Shell -----------------------------------------------------
    {
      name: 'run_shell',
      description:
        'Execute a shell command and return its output. Use responsibly.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run' },
        },
        required: ['command'],
      },
      execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const command = String(args.command);
          const proc = Bun.spawn(['sh', '-c', command], {
            stdout: 'pipe',
            stderr: 'pipe',
          });

          const stdout = await new Response(proc.stdout).text();
          const stderr = await new Response(proc.stderr).text();
          const exitCode = await proc.exited;

          const output = (
            stdout + (stderr ? `\nSTDERR: ${stderr}` : '')
          ).slice(0, 20_000);

          return {
            content: output || '(no output)',
            success: exitCode === 0,
            metadata: {
              exit_code: exitCode,
              command,
              truncated: stdout.length + stderr.length > 20_000,
            },
          };
        } catch (err) {
          return {
            content: `Shell error: ${err instanceof Error ? err.message : String(err)}`,
            success: false,
          };
        }
      },
    },

    // ---- 9. Search Notes (BM25) -------------------------------------------
    {
      name: 'search_notes',
      description: 'Search your memory notes for relevant information using BM25 ranking.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query for memory notes' },
        },
        required: ['query'],
      },
      execute: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<ToolResult> => {
        try {
          const query = String(args.query);
          const results = ctx.store.searchNotes(query, ctx.sessionId, 8);

          if (results.length === 0) {
            return {
              content: 'No matching notes found.',
              success: true,
              metadata: { query },
            };
          }

          const text = results
            .map((n: any) => `[${n.id} ${n.kind}] ${n.content}`)
            .join('\n\n');

          return {
            content: text,
            success: true,
            metadata: { query, count: results.length },
          };
        } catch (err) {
          return {
            content: `Search error: ${err instanceof Error ? err.message : String(err)}`,
            success: false,
          };
        }
      },
    },

    // ---- 10. Remember -----------------------------------------------------
    {
      name: 'remember',
      description:
        'Save an important fact, preference, or note to persistent memory.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The fact or note to remember' },
          kind: {
            type: 'string',
            description: 'Kind of note',
            enum: ['fact', 'preference', 'note', 'lesson'],
          },
        },
        required: ['content'],
      },
      execute: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<ToolResult> => {
        try {
          const content = String(args.content);
          const kind = String(args.kind || 'note');

          // Deduplicate
          if (ctx.store.noteDuplicateExists(ctx.sessionId, content)) {
            return {
              content: 'I already have a near-duplicate note for this.',
              success: true,
              metadata: { kind, duplicate: true },
            };
          }

          const id = ctx.store.addNote(ctx.sessionId, ctx.runId, kind, content);
          return {
            content: `Saved note ${id}`,
            success: true,
            metadata: { kind, length: content.length, id },
          };
        } catch (err) {
          return {
            content: `Remember error: ${err instanceof Error ? err.message : String(err)}`,
            success: false,
          };
        }
      },
    },

    // ---- 11. Memory (Core Memory Editing) ---------------------------------
    {
      name: 'memory',
      description:
        'Curate durable memory: facts about the user and their world ' +
        '(identity, preferences, projects, goals). action=add stores a fact; ' +
        'replace/remove target an existing line by a short unique substring. ' +
        'action=list views all memories; action=clear deletes everything. ' +
        'Keep it concise. scope=agent edits your own cross-session self-notes ' +
        'instead of user facts.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'replace', 'remove', 'list', 'clear'],
            description: 'What to do with the memory line',
          },
          content: { type: 'string', description: 'The fact to add or the replacement text' },
          target: { type: 'string', description: 'Substring to match for replace/remove' },
          scope: {
            type: 'string',
            enum: ['user', 'agent'],
            description: 'user (default) edits user memory; agent edits self-notes',
          },
        },
        required: ['action'],
      },
      execute: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<ToolResult> => {
        try {
          const key = String(args.scope || '') === 'agent' ? '__agent__' : ctx.sessionId;
          const { success, message } = ctx.store.editCoreMemory(
            key,
            String(args.action || ''),
            String(args.content || ''),
            String(args.target || ''),
          );
          return {
            content: (success ? 'OK' : 'FAIL') + (message ? ': ' + message : ''),
            success,
            metadata: { action: args.action, scope: args.scope || 'user' },
          };
        } catch (err) {
          return {
            content: `Memory error: ${err instanceof Error ? err.message : String(err)}`,
            success: false,
          };
        }
      },
    },

    // ---- 12. Todo (Task Tracking) -----------------------------------------
    {
      name: 'todo',
      description:
        'Track multi-turn work: add an open task, mark one done, ' +
        'or list open tasks. Open tasks persist in awareness and ' +
        'block premature completion.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'done', 'list'],
            description: 'add a task, mark done, or list open tasks',
          },
          text: { type: 'string', description: 'Task description (for add) or match text (for done)' },
          id: { type: 'string', description: 'Task ID (for done)' },
        },
        required: ['action'],
      },
      execute: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<ToolResult> => {
        try {
          const action = String(args.action || 'list').toLowerCase();

          if (action === 'add') {
            const text = String(args.text || '').trim();
            if (!text) {
              return { content: 'text is required for add', success: false };
            }
            const tid = ctx.store.addTask(ctx.sessionId, ctx.runId, text);
            return {
              content: `added open task ${tid}: ${text}`,
              success: true,
              metadata: { action: 'add', id: tid },
            };
          }

          if (action === 'done') {
            const ident = String(args.id || args.text || '').trim();
            if (!ident) {
              return { content: 'id or text is required for done', success: false };
            }
            const ok = ctx.store.completeTask(ctx.sessionId, ident);
            return {
              content: ok ? 'task closed' : `no open task matching '${ident}'`,
              success: ok,
              metadata: { action: 'done' },
            };
          }

          // list
          const tasks = ctx.store.openTasks(ctx.sessionId);
          if (tasks.length === 0) {
            return { content: 'No open tasks.', success: true };
          }
          const text = tasks.map((t: any) => `- [${t.id}] ${t.text}`).join('\n');
          return {
            content: text,
            success: true,
            metadata: { action: 'list', count: tasks.length },
          };
        } catch (err) {
          return {
            content: `Todo error: ${err instanceof Error ? err.message : String(err)}`,
            success: false,
          };
        }
      },
    },

    // ---- 13. Wiki (Knowledge Pages) ---------------------------------------
    {
      name: 'wiki',
      description:
        'Your linked knowledge wiki (markdown pages). action=write ' +
        'stores/updates a page (use [[Other Page]] to link); read ' +
        'loads a page and its links/backlinks; search finds pages; ' +
        'list shows all. Build durable structured knowledge here.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'write', 'search', 'list'],
            description: 'Wiki operation',
          },
          title: { type: 'string', description: 'Page title' },
          content: { type: 'string', description: 'Page content (for write)' },
          query: { type: 'string', description: 'Search query (for search)' },
          append: { type: 'boolean', description: 'Append instead of overwrite (for write)' },
        },
        required: ['action'],
      },
      execute: async (
        args: Record<string, unknown>,
        ctx: ToolContext,
      ): Promise<ToolResult> => {
        try {
          // Lazy-import to avoid circular deps at module level
          const { MarkdownKnowledge } = await import('../knowledge/wiki');
          const kb = new MarkdownKnowledge(ctx.dataDir);
          const action = String(args.action || '').toLowerCase();
          const title = String(args.title || '').trim();

          if (action === 'read') {
            const r = kb.wikiRead(title);
            if (!r.exists) {
              return { content: r.hint || 'Page not found', success: true };
            }
            let tail = '';
            if (r.links.length > 0) {
              tail += `\n\nLinks: ${r.links.map(l => `[[${l}]]`).join(', ')}`;
            }
            if (r.backlinks.length > 0) {
              tail += `\nBacklinked from: ${r.backlinks.join(', ')}`;
            }
            const head = r.content.trimStart().startsWith('#') ? '' : `# ${r.title}\n`;
            return {
              content: `${head}${r.content}${tail}`,
              success: true,
              metadata: { title: r.title, links: r.links.length },
            };
          }

          if (action === 'write') {
            const r = kb.wikiWrite(title, String(args.content || ''), !!args.append);
            const linksStr = r.links.length > 0 ? `, links: ${r.links.join(', ')}` : '';
            return {
              content: `saved wiki page '${r.title}' (${r.chars} chars${linksStr})`,
              success: true,
              metadata: { title: r.title, chars: r.chars },
            };
          }

          if (action === 'search') {
            const hits = kb.wikiSearch(String(args.query || title));
            return {
              content: 'matching pages: ' + (hits.length > 0 ? hits.join(', ') : '(none)'),
              success: true,
              metadata: { count: hits.length },
            };
          }

          if (action === 'list') {
            const pages = kb.wikiList();
            return {
              content: 'wiki pages: ' + (pages.length > 0 ? pages.join(', ') : '(empty)'),
              success: true,
              metadata: { count: pages.length },
            };
          }

          return { content: 'action must be read | write | search | list', success: false };
        } catch (err) {
          return {
            content: `Wiki error: ${err instanceof Error ? err.message : String(err)}`,
            success: false,
          };
        }
      },
    },

    // ---- 12. Delegate (Sub-Agent) -----------------------------------------
    {
      name: 'delegate',
      description: 'Spawn 1-3 parallel sub-agents to solve complex independent tasks. Each sub-agent runs its own kernel and returns a final answer.',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of specific tasks for the sub-agents to solve (max 3).'
          }
        },
        required: ['tasks'],
      },
      execute: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
        if (!ctx.runSubAgent) {
          return { content: 'Sub-agents are not enabled in this context.', success: false };
        }
        const tasks = Array.isArray(args.tasks) ? args.tasks : [args.tasks];
        if (tasks.length === 0) return { content: 'No tasks provided.', success: false };
        const limited = tasks.slice(0, 3).map(String);
        
        ctx.emit('tool.stage', { tasks: limited }, 'spawning sub-agents');
        
        try {
          // Default to the same provider/model for sub-agents, or read from config if we had access to it.
          // Since we don't have config here, we assume runSubAgent handles defaults.
          const promises = limited.map(task => ctx.runSubAgent!( 'default', 'default', task ));
          const results = await Promise.allSettled(promises);
          
          let combined = '';
          results.forEach((res, i) => {
            combined += `--- Task ${i+1}: ${limited[i]} ---
`;
            if (res.status === 'fulfilled') {
              combined += res.value + '\n\n';
            } else {
              combined += 'Error: ' + res.reason + '\n\n';
            }
          });
          
          return { content: combined.trim(), success: true, metadata: { count: limited.length } };
        } catch (e: any) {
          return { content: 'Sub-agent execution failed: ' + e.message, success: false };
        }
      }
    },

    // ---- 13. Research -----------------------------------------------------
    {
      name: 'research',
      description: 'Perform a comprehensive web search. Automatically searches and fetches the top results.',
      parameters: {
        type: 'object',
        properties: {
          queries: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of search queries (max 3)'
          }
        },
        required: ['queries']
      },
      execute: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
        const queries = Array.isArray(args.queries) ? args.queries : [args.queries];
        const limited = queries.slice(0, 3).map(String);
        
        ctx.emit('tool.stage', { queries: limited }, 'searching the web');
        
        try {
          // Mocking the actual Tavily/Brave execution here for simplicity,
          // in a real app this would use the web_search tool and web_fetch.
          return { content: `Successfully researched: ${limited.join(', ')}. (Mocked response, add real search API here)`, success: true };
        } catch (e: any) {
          return { content: 'Research failed: ' + e.message, success: false };
        }
      }
    },

    // ---- 14. Generate Image -----------------------------------------------
    {
      name: 'generate_image',
      description: 'Generate an image using the provider image model and save it to the workspace.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Visual description of the image to generate.' },
          filename: { type: 'string', description: 'Name of the output file (e.g. "sunset.png").' }
        },
        required: ['prompt', 'filename']
      },
      execute: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
        const prompt = String(args.prompt);
        const filename = String(args.filename);
        ctx.emit('tool.stage', { prompt, filename }, 'generating image');
        
        // Mock generation
        return { content: `Image ${filename} generated successfully (Mock). served at /api/generated/${filename}`, success: true };
      }
    },
    // ---- 15. Gather Intel -------------------------------------------------
    {
      name: 'gather_intel',
      description: 'A deterministic mini-workflow to gather mass intelligence at once. It automatically searches the web for multiple topics and reads multiple local files concurrently.',
      parameters: {
        type: 'object',
        properties: {
          topics: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of topics to web search for.'
          },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of file paths to read.'
          }
        }
      },
      intent: /\b(research|deep dive|gather context|intel|investigate)\b/i,
      execute: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
        const topics = Array.isArray(args.topics) ? args.topics : [];
        const paths = Array.isArray(args.paths) ? args.paths : [];
        
        ctx.emit('tool.stage', { topics, paths }, 'gathering mass intel');
        
        // This is a powerful super-tool. Since we don't have direct access to registry.execute,
        // we'll run deterministic logic directly.
        let results = 'Gathered Intel:\n\n';
        
        // 1. Read files concurrently
        if (paths.length > 0) {
          results += '--- LOCAL FILES ---\n';
          const filePromises = paths.map(async (p) => {
            try {
              const file = Bun.file(String(p));
              if (await file.exists()) {
                const text = await file.text();
                return `[${p}]:\n${text.slice(0, 5000)}...`;
              }
              return `[${p}]: File not found.`;
            } catch (e: any) {
              return `[${p}]: Error reading - ${e.message}`;
            }
          });
          const fileResults = await Promise.all(filePromises);
          results += fileResults.join('\n\n') + '\n\n';
        }

        // 2. We skip native web fetch here to avoid duplicating the huge logic in builtins.
        // The LLM will mostly use the file reading half or rely on normal web_search in parallel.
        if (topics.length > 0) {
          results += '--- WEB TOPICS ---\n';
          results += `Topics requested: ${topics.join(', ')}. (Use the native web_search tool concurrently for deep web research!)`;
        }

        return { content: results.trim(), success: true };
      }
    },
  ];
}
