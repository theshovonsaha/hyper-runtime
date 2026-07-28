/**
 * core/ascii_transform.ts — ASCII Byte-Stream Normalization & Regex-Based
 * Variable Renaming Utility.
 *
 * CHANGED: this was previously called an "AST Transformation Engine," which
 * overclaims what it does — there is no parser here, just a `\b`-bounded
 * regex replace. Renamed the framing in this docstring to match reality.
 * `transformCodeAst` is still regex-based (a real AST transform needs an
 * actual parser for the target language, out of scope for a drop-in fix),
 * but it now:
 *   - escapes regex metacharacters in variable names (a name like `$foo`
 *     or `a.b` used to either silently misbehave or throw depending on
 *     content),
 *   - is documented as unsafe for renaming inside string/comment literals,
 *     since a real fix for that requires a real parser, not a bigger regex.
 */

import { createHash } from 'crypto';

export interface AsciiByteBlock {
  id: string;
  asciiText: string;
  byteLength: number;
  sha256Fingerprint: string;
  transformStage: string;
}

export class AsciiTransformEngine {
  /** Convert string payload into a normalized ASCII byte block with SHA-256 lineage fingerprint */
  createAsciiBlock(id: string, text: string, stage = 'normalized'): AsciiByteBlock {
    const asciiText = String(text || '').replace(/[^\x00-\x7F]/g, ''); // Strip non-ASCII for clean byte stream
    const byteLength = Buffer.byteLength(asciiText, 'utf-8');
    const sha256Fingerprint = createHash('sha256').update(asciiText).digest('hex');

    return {
      id,
      asciiText,
      byteLength,
      sha256Fingerprint,
      transformStage: stage,
    };
  }

  /**
   * Naive regex-based identifier rename. NOT AST-aware: it will also match
   * inside string literals and comments containing the same identifier text.
   * Fine for quick renames in trusted, reviewed code; don't run this
   * unattended over arbitrary/untrusted source.
   */
  transformCodeAst(codeBlock: string, variableRenames: Record<string, string>): string {
    let transformed = codeBlock;
    for (const [oldVar, newVar] of Object.entries(variableRenames)) {
      const escaped = oldVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // FIXED: was unescaped, broke/misbehaved on names with regex metachars
      const regex = new RegExp(`\\b${escaped}\\b`, 'g');
      transformed = transformed.replace(regex, newVar);
    }
    return transformed;
  }
}
