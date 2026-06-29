/**
 * localEmbeddings.ts
 *
 * Drop-in replacement for retrieveKnowledge() from milvus.ts.
 * Loads the pre-computed embeddings.json and does cosine similarity
 * entirely in-memory — no external services required.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import OpenAI from 'openai';

// ─── Types ────────────────────────────────────────────────────────────────────
type Chunk = {
  id: string;
  source: string;
  category: string;
  text: string;
  embedding: number[];
};

type EmbeddingsFile = {
  chunks: Chunk[];
};

// ─── Singleton loader — file is read once per process ────────────────────────
let _chunks: Chunk[] | null = null;

function getChunks(): Chunk[] {
  if (_chunks) return _chunks;

  // Try compressed file first (used in production), fall back to plain JSON (legacy)
  const gzPath   = path.join(process.cwd(), 'knowledge', 'embeddings.json.gz');
  const jsonPath  = path.join(process.cwd(), 'knowledge', 'embeddings.json');

  let raw: string;
  if (fs.existsSync(gzPath)) {
    const compressed = fs.readFileSync(gzPath);
    raw = zlib.gunzipSync(compressed).toString('utf-8');
    console.log('[LocalEmbeddings] Loaded from embeddings.json.gz');
  } else if (fs.existsSync(jsonPath)) {
    raw = fs.readFileSync(jsonPath, 'utf-8');
    console.log('[LocalEmbeddings] Loaded from embeddings.json');
  } else {
    console.error('[LocalEmbeddings] No embeddings file found. Run: npx tsx scripts/build_embeddings.ts');
    return [];
  }

  const data: EmbeddingsFile = JSON.parse(raw);
  _chunks = data.chunks;
  console.log(`[LocalEmbeddings] ${_chunks.length} chunks ready`);
  return _chunks;
}

// ─── OpenAI client ───────────────────────────────────────────────────────────
let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

// ─── Cosine similarity ───────────────────────────────────────────────────────
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) + 1e-10);
}

// ─── Category filter ─────────────────────────────────────────────────────────
// The sales playbooks live under knowledge/uk/ and are tagged 'uk' in the
// embeddings index, but they apply to ALL markets — not just UK. The geo-specific
// tone (currency, VAT, formality) is handled by the system prompt; the underlying
// process playbooks (complaint handling, objections, quotes, follow-ups) are universal.
function categoryFilter(chunk: Chunk, category?: string): boolean {
  if (!category) return true;
  // 'core' chunks (frames_and_finishes.md, customization_rules.md, etc.) are
  // essential for answering product questions — include them alongside 'product'
  if (category === 'product') return ['product', 'core'].includes(chunk.category);
  // 'uk' chunks (sales playbooks) are included alongside 'playbook' and 'core'
  // for training, email drafting, and geo queries — they are universal process guides
  if (category === 'training') return ['core', 'playbook', 'uk'].includes(chunk.category);
  if (category === 'email')    return ['core', 'playbook', 'uk'].includes(chunk.category);
  if (category === 'callprep') return ['core', 'uk'].includes(chunk.category);
  return true;
}

// ─── Main retrieval function (same signature as milvus.ts) ───────────────────
const MAX_CHUNK_DISPLAY_CHARS = 3000;

export async function retrieveKnowledge(
  query: string,
  category?: string,
  topK = 5
): Promise<string> {
  try {
    const chunks = getChunks();
    if (!chunks.length) return '';

    // Embed the query using OpenAI (same model as build script)
    const res = await getOpenAI().embeddings.create({
      model: 'text-embedding-3-small',
      input: query.slice(0, 7000),
    });
    const queryVec = res.data[0].embedding;

    // Score all chunks
    const scored = chunks
      .filter(c => categoryFilter(c, category))
      .map(c => ({ chunk: c, score: cosineSimilarity(queryVec, c.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    if (!scored.length) return '';

    console.log(`[LocalEmbeddings] Top match: "${scored[0].chunk.source}" score=${scored[0].score.toFixed(3)}`);

    // Group consecutive chunks from the same source file so the model gets
    // contiguous context rather than scattered fragments
    const grouped = new Map<string, string[]>();
    for (const { chunk } of scored) {
      if (!grouped.has(chunk.source)) grouped.set(chunk.source, []);
      grouped.get(chunk.source)!.push(chunk.text);
    }

    return [...grouped.entries()]
      .map(([source, texts]) => `[${source}]\n${texts.join('\n').slice(0, MAX_CHUNK_DISPLAY_CHARS)}`)
      .join('\n\n---\n\n');

  } catch (err) {
    console.error('[LocalEmbeddings] retrieval error:', err);
    return '';
  }
}

// retrieveTranscripts stays on Milvus for now (transcripts aren't in embeddings.json)
// Re-export a no-op so route.ts doesn't break if transcripts aren't available
export async function retrieveTranscripts(
  _query: string,
  _topK = 4
): Promise<string> {
  // Transcripts are not bundled — fall back to Milvus path or return empty
  return '';
}
