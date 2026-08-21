import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import type { SessionFileRecord, SessionKnowledgeChunk } from './operator-store';

export const MAX_SESSION_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_SESSION_FILES = 32;
export const MAX_INDEXED_TEXT_CHARS = 200_000;
export const MAX_KNOWLEDGE_CHUNKS_PER_FILE = 128;

export interface EmbeddingProvider {
  readonly model: string;
  embed(inputs: string[]): Promise<number[][]>;
}

export interface EmbeddingProfile {
  id: string;
  label: string;
  model: string;
  provider?: EmbeddingProvider;
  dimensions?: number;
  limitation?: string;
}

export interface OpenAiEmbeddingOptions {
  model: string;
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  dimensions?: number;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  private readonly fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

  constructor(private readonly options: OpenAiEmbeddingOptions) {
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async embed(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) return [];
    if (inputs.length > 64 || inputs.reduce((total, value) => total + value.length, 0) > 200_000) {
      throw new Error('Embedding request exceeds the bounded batch limit.');
    }
    const endpoint = new URL('embeddings', this.options.baseUrl.replace(/\/?$/, '/'));
    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        input: inputs,
        encoding_format: 'float',
        ...(this.options.dimensions ? { dimensions: this.options.dimensions } : {}),
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
    });
    const text = await response.text();
    if (text.length > 8_000_000) throw new Error('Embedding response exceeds 8 MB.');
    if (!response.ok) throw new Error(`Embedding provider returned HTTP ${response.status}.`);
    const body = JSON.parse(text) as { data?: Array<{ index?: number; embedding?: unknown }> };
    const vectors = (body.data ?? [])
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map(item => Array.isArray(item.embedding)
        ? item.embedding.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
        : []);
    if (vectors.length !== inputs.length || vectors.some(vector => vector.length === 0)) {
      throw new Error('Embedding provider returned an incomplete vector batch.');
    }
    const dimensions = vectors[0]!.length;
    if (dimensions > 4_096 || vectors.some(vector => vector.length !== dimensions)) {
      throw new Error('Embedding vectors have invalid or inconsistent dimensions.');
    }
    return vectors;
  }
}

const TEXT_MEDIA_TYPES = new Set([
  'application/json',
  'application/javascript',
  'application/typescript',
  'application/xml',
  'application/x-yaml',
  'text/csv',
  'text/html',
  'text/javascript',
  'text/markdown',
  'text/plain',
  'text/typescript',
  'text/xml',
  'text/yaml',
]);

const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.css', '.csv', '.go', '.h', '.hpp', '.html', '.java', '.js', '.json',
  '.jsx', '.md', '.mjs', '.py', '.rb', '.rs', '.sh', '.sql', '.toml', '.ts', '.tsx', '.txt',
  '.xml', '.yaml', '.yml',
]);

function safeFileName(value: string): string {
  const normalized = basename(value).normalize('NFKC').replace(/[^\p{L}\p{N}._ -]+/gu, '_').trim();
  return (normalized || 'upload').slice(0, 180);
}

function sessionDirectory(root: string, sessionId: string): string {
  const key = createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
  return resolve(root, key);
}

function extractText(bytes: Uint8Array, name: string, mediaType: string): { text?: string; limitation?: string } {
  const extension = extname(name).toLocaleLowerCase();
  if (!mediaType.startsWith('text/') && !TEXT_MEDIA_TYPES.has(mediaType) && !TEXT_EXTENSIONS.has(extension)) {
    return { limitation: `No bounded text extractor is configured for ${mediaType || extension || 'this file type'}.` };
  }
  if (bytes.includes(0)) return { limitation: 'The file appears binary and was stored without text extraction.' };
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replaceAll('\r\n', '\n').trim();
    return text ? { text } : { limitation: 'The uploaded file contains no extractable text.' };
  } catch {
    return { limitation: 'The file is not valid UTF-8 and no alternate text decoder is configured.' };
  }
}

export function chunkText(content: string, maximum = 1_600, overlap = 240): string[] {
  if (!content.trim()) return [];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < content.length && chunks.length < MAX_KNOWLEDGE_CHUNKS_PER_FILE) {
    let end = Math.min(content.length, offset + maximum);
    if (end < content.length) {
      const boundary = Math.max(
        content.lastIndexOf('\n\n', end),
        content.lastIndexOf('\n', end),
        content.lastIndexOf('. ', end),
      );
      if (boundary > offset + Math.floor(maximum * 0.55)) end = boundary + 1;
    }
    const chunk = content.slice(offset, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= content.length) break;
    offset = Math.max(offset + 1, end - overlap);
  }
  return chunks;
}

export interface IngestSessionFileInput {
  sessionId: string;
  ingestionId: string;
  file: File;
  storageRoot: string;
  createdAt: string;
  embeddingProvider?: EmbeddingProvider;
  embeddingProfileId?: string;
  validFrom?: string;
  validTo?: string;
}

export async function ingestSessionFile(input: IngestSessionFileInput): Promise<{
  record: SessionFileRecord;
  chunks: Array<Omit<SessionKnowledgeChunk, 'terms' | 'entities'>>;
}> {
  if (input.file.size <= 0) throw new Error('Uploaded file is empty.');
  if (input.file.size > MAX_SESSION_FILE_BYTES) throw new Error('Uploaded file exceeds the 8 MB session limit.');
  const name = safeFileName(input.file.name);
  const mediaType = (input.file.type || 'application/octet-stream').slice(0, 200);
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const id = `file:${randomUUID()}`;
  const directory = join(sessionDirectory(input.storageRoot, input.sessionId), id.replace(':', '_'));
  mkdirSync(directory, { recursive: true });
  const storagePath = join(directory, name);
  const temporary = `${storagePath}.${process.pid}.tmp`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, storagePath);

  const extracted = extractText(bytes, name, mediaType);
  const indexedText = extracted.text?.slice(0, MAX_INDEXED_TEXT_CHARS);
  const texts = indexedText ? chunkText(indexedText) : [];
  let embeddings: number[][] | undefined;
  let embeddingLimitation: string | undefined;
  if (texts.length > 0 && input.embeddingProvider) {
    try {
      embeddings = [];
      for (let offset = 0; offset < texts.length; offset += 32) {
        embeddings.push(...await input.embeddingProvider.embed(texts.slice(offset, offset + 32)));
      }
    } catch (error) {
      embeddingLimitation = `Embedding failed; lexical, temporal, and relationship retrieval remain active. ${error instanceof Error ? error.message : String(error)}`;
      embeddings = undefined;
    }
  } else if (texts.length > 0) {
    embeddingLimitation = 'No embedding model is configured; lexical, temporal, and relationship retrieval remain active.';
  }
  const indexingLimitation = extracted.text && extracted.text.length > MAX_INDEXED_TEXT_CHARS
    ? `Only the first ${MAX_INDEXED_TEXT_CHARS.toLocaleString('en-US')} text characters were indexed under the bounded ingestion policy.`
    : undefined;
  const limitation = [extracted.limitation, indexingLimitation, embeddingLimitation].filter(Boolean).join(' ') || undefined;
  const chunks = texts.map((content, ordinal) => ({
    id: `${id}:chunk:${ordinal}`,
    documentId: id,
    sessionId: input.sessionId,
    ordinal,
    content,
    createdAt: input.createdAt,
    provenance: [input.ingestionId, id],
    ...(embeddings?.[ordinal] ? { embedding: embeddings[ordinal] } : {}),
    ...(input.validFrom ? { validFrom: input.validFrom } : {}),
    ...(input.validTo ? { validTo: input.validTo } : {}),
  }));
  const record: SessionFileRecord = {
    id,
    ingestionId: input.ingestionId,
    sessionId: input.sessionId,
    name,
    mediaType,
    sizeBytes: bytes.byteLength,
    sha256,
    storagePath,
    createdAt: input.createdAt,
    status: limitation ? 'limited' : 'ready',
    retrievalMode: chunks.length === 0 ? 'metadata_only' : embeddings ? 'hybrid' : 'lexical',
    chunkIds: chunks.map(chunk => chunk.id),
    ...(input.embeddingProvider && embeddings ? { embeddingModel: input.embeddingProvider.model } : {}),
    ...(input.embeddingProvider && embeddings && input.embeddingProfileId
      ? { embeddingProfileId: input.embeddingProfileId }
      : {}),
    ...(limitation ? { limitation } : {}),
    ...(input.validFrom ? { validFrom: input.validFrom } : {}),
    ...(input.validTo ? { validTo: input.validTo } : {}),
  };
  return { record, chunks };
}

export function removeStoredSessionFile(path: string, storageRoot: string): void {
  const root = resolve(storageRoot);
  const target = resolve(path);
  if (target !== root && !target.startsWith(`${root}/`)) throw new Error('Session file path escapes the storage root.');
  try { unlinkSync(target); } catch { /* Metadata deletion remains deterministic if bytes were already absent. */ }
}

export function publicSessionFile(record: SessionFileRecord): Omit<SessionFileRecord, 'storagePath'> {
  const { storagePath: _storagePath, ...publicRecord } = record;
  return publicRecord;
}
