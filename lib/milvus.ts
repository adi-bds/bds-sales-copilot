import { MilvusClient } from '@zilliz/milvus2-sdk-node';
import OpenAI from 'openai';

const COLLECTION = 'bds_knowledge';

// Singleton clients — reused across requests in the same serverless instance
let milvusClient: MilvusClient | null = null;
let openaiClient: OpenAI | null = null;

// Zilliz serverless addresses may include "https://" — strip it for gRPC.
// gRPC requires "hostname:443" (no protocol prefix). TLS is automatic on port 443.
function normalizeGrpcAddress(addr: string): string {
  const host = addr.replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/:443$/, '');
  return `${host}:443`;
}

function getMilvus(): MilvusClient {
  if (!milvusClient) {
    milvusClient = new MilvusClient({
      address: normalizeGrpcAddress(process.env.MILVUS_ADDRESS!),
      token: process.env.MILVUS_TOKEN!,
    });
  }
  return milvusClient;
}

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

/**
 * Embed a query string using OpenAI text-embedding-3-small.
 */
async function embed(text: string): Promise<number[]> {
  const res = await getOpenAI().embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 7000),
  });
  return res.data[0].embedding;
}

/**
 * Retrieve the most relevant knowledge chunks from Milvus for a given query.
 *
 * @param query     - The rep's recent message(s) joined as one string
 * @param category  - Optional nav category ('product' | 'training' | 'callprep' | 'general')
 * @param topK      - Number of chunks to retrieve (default 6)
 * @returns         - Retrieved chunks joined as a formatted string, ready for system prompt injection
 */
export async function retrieveKnowledge(
  query: string,
  category?: string,
  topK = 6
): Promise<string> {
  try {
    const vector = await embed(query);

    // Narrow results to the most relevant category when known
    const filter =
      category === 'product'  ? `category == "product"` :
      category === 'training' ? `category in ["core", "playbook"]` :
      category === 'callprep' ? `category == "core"` :
      undefined;

    const results = await getMilvus().search({
      collection_name: COLLECTION,
      data: [vector],
      limit: topK,
      metric_type: 'COSINE',
      output_fields: ['text', 'source'],
      ...(filter ? { filter } : {}),
    });

    if (!results.results?.length) {
      console.warn('[Milvus] No results returned for query.');
      return '';
    }

    console.log(`[Milvus] Retrieved ${results.results.length} chunks for category="${category ?? 'all'}"`);

    return results.results
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((r: any) => `[${r.source}]\n${r.text}`)
      .join('\n\n---\n\n');

  } catch (err) {
    console.error('[Milvus] Retrieval error:', err);
    return ''; // Fail gracefully — copilot still works without RAG context
  }
}

/**
 * Search call transcripts in Milvus for relevant examples.
 * Only called when the query is about past calls, objections, rep behavior, etc.
 *
 * @param query  - The rep's question
 * @param topK   - Number of transcript chunks to retrieve (default 4)
 * @returns      - Formatted transcript excerpts with rep/date metadata
 */
export async function retrieveTranscripts(
  query: string,
  topK = 4
): Promise<string> {
  try {
    const vector = await embed(query);

    const results = await getMilvus().search({
      collection_name: 'bds_transcripts',
      data: [vector],
      limit: topK,
      metric_type: 'COSINE',
      output_fields: ['text', 'rep', 'geo', 'date', 'duration'],
    });

    if (!results.results?.length) return '';

    console.log(`[Milvus] Retrieved ${results.results.length} transcript chunks`);

    return results.results
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((r: any) => {
        const mins = Math.floor(r.duration / 60);
        return `[Call: ${r.rep} | ${r.geo} | ${r.date} | ${mins}min]\n${r.text}`;
      })
      .join('\n\n---\n\n');

  } catch (err) {
    // Transcripts collection may not exist yet — fail silently
    return '';
  }
}
