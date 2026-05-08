/**
 * Knowledge retrieval via Zilliz REST API + OpenAI embeddings.
 * Replaces the gRPC-based SDK — Zilliz Serverless is REST-only.
 */

import OpenAI from 'openai';
import { searchCollection, searchTranscripts } from './zilliz';

const COLLECTION = 'bds_knowledge';

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

async function embed(text: string): Promise<number[]> {
  const res = await getOpenAI().embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 7000),
  });
  return res.data[0].embedding;
}

// Safety cap: never send more than this many chars per retrieved chunk to Claude.
// Older collections may have large chunks; this ensures cost stays predictable
// regardless of what's stored. At 3,000 chars × 5 chunks ≈ 3,750 tokens.
const MAX_CHUNK_DISPLAY_CHARS = 3000;

export async function retrieveKnowledge(
  query: string,
  category?: string,
  topK = 5
): Promise<string> {
  try {
    const vector = await embed(query);

    const filter =
      category === 'product'  ? `category == "product"` :
      category === 'training' ? `category in ["core", "playbook"]` :
      category === 'callprep' ? `category == "core"` :
      undefined;

    const results = await searchCollection(COLLECTION, vector, topK, filter);

    if (!results.length) {
      console.warn('[Zilliz] No results returned for query.');
      return '';
    }

    console.log(`[Zilliz] Retrieved ${results.length} chunks for category="${category ?? 'all'}"`);
    return results
      .map(r => `[${r.source}]\n${r.text.slice(0, MAX_CHUNK_DISPLAY_CHARS)}`)
      .join('\n\n---\n\n');

  } catch (err) {
    console.error('[Zilliz] Knowledge retrieval error:', err);
    return '';
  }
}

export async function retrieveTranscripts(
  query: string,
  topK = 4
): Promise<string> {
  try {
    const vector = await embed(query);
    const results = await searchTranscripts(vector, topK);

    if (!results.length) return '';

    console.log(`[Zilliz] Retrieved ${results.length} transcript chunks`);
    return results.map(r => {
      const mins = Math.floor((r.duration ?? 0) / 60);
      return `[Call: ${r.rep} | ${r.geo} | ${r.date} | ${mins}min]\n${r.text}`;
    }).join('\n\n---\n\n');

  } catch (err) {
    return '';
  }
}
