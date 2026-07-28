/**
 * core/workflows.ts — Prompt Template Renderer & Workflow Engine.
 * Ported from python workflows.py
 */

export function renderTemplate(template: string, args: Record<string, unknown>): string {
  if (!template) {
    return JSON.stringify(args, null, 2).slice(0, 4000);
  }

  return template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (match: string, key: string) => {
    if (key === '__raw__') {
      return JSON.stringify(args, null, 2).slice(0, 4000);
    }
    const parts = key.split('.');
    let val: any = args;
    for (const part of parts) {
      if (typeof val === 'object' && val !== null && part in val) {
        val = val[part];
      } else {
        return match; // leave unresolved token literal
      }
    }
    if (typeof val === 'object') {
      return JSON.stringify(val, null, 2).slice(0, 2000);
    }
    return String(val);
  });
}

export function templateArgNames(template: string): string[] {
  const matches = template.match(/\{([a-zA-Z0-9_.]+)\}/g) || [];
  const names = new Set<string>();
  for (const m of matches) {
    const raw = m.slice(1, -1).split('.')[0];
    if (raw !== '__raw__') {
      names.add(raw);
    }
  }
  return Array.from(names).sort();
}

export function slugify(text: string): string {
  const slug = String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug.slice(0, 60) || 'workflow';
}
