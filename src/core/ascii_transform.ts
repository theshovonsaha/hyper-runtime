/**
 * core/ascii_transform.ts — Unified ASCII Byte-Stream & Code AST Transformation Engine.
 *
 * PHILOSOPHY: All is language, all is code, all is data flowing and transforming.
 * Treats prompts, ASTs, JSON schemas, and system logs as unified, transformable ASCII byte streams.
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

  /** In-Flight Code AST Byte Transformation */
  transformCodeAst(codeBlock: string, variableRenames: Record<string, string>): string {
    let transformed = codeBlock;
    for (const [oldVar, newVar] of Object.entries(variableRenames)) {
      const regex = new RegExp(`\\b${oldVar}\\b`, 'g');
      transformed = transformed.replace(regex, newVar);
    }
    return transformed;
  }
}
