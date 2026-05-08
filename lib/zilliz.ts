/**
 * Zilliz REST API client
 * Replaces the gRPC-based @zilliz/milvus2-sdk-node SDK.
 * Zilliz Serverless clusters are REST-only — gRPC is not supported externally.
 */

const BASE_URL = (() => {
  const addr = process.env.MILVUS_ADDRESS ?? '';
  return addr.startsWith('http') ? addr.replace(/\/$/, '') : `https://${addr}`;
})();

const TOKEN = process.env.MILVUS_TOKEN ?? '';

async function zillizFetch(path: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    throw new Error(`Zilliz HTTP ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as { code: number; message?: string; data?: unknown };
  if (data.code !== 0) {
    throw new Error(`Zilliz API error ${data.code}: ${data.message ?? JSON.stringify(data)}`);
  }
  return data.data;
}

// ── Collection management ─────────────────────────────────────────────────────

export async function collectionExists(name: string): Promise<boolean> {
  const collections = await zillizFetch('/v2/vectordb/collections/list', { dbName: 'default' }) as string[];
  return collections.includes(name);
}

export async function dropCollection(name: string): Promise<void> {
  await zillizFetch('/v2/vectordb/collections/drop', { collectionName: name });
}

export async function createCollection(name: string, dim: number): Promise<void> {
  await zillizFetch('/v2/vectordb/collections/create', {
    collectionName: name,
    dimension: dim,
    metricType: 'COSINE',
    primaryFieldName: 'id',
    vectorFieldName: 'vector',
    schema: {
      autoId: true,
      fields: [
        { fieldName: 'id',       dataType: 'Int64',   isPrimary: true, autoId: true },
        { fieldName: 'text',     dataType: 'VarChar', elementTypeParams: { max_length: '65535' } },
        { fieldName: 'source',   dataType: 'VarChar', elementTypeParams: { max_length: '200'  } },
        { fieldName: 'category', dataType: 'VarChar', elementTypeParams: { max_length: '50'   } },
        { fieldName: 'vector',   dataType: 'FloatVector', elementTypeParams: { dim: String(dim) } },
      ],
    },
    // No indexParams — `dimension` shorthand already creates the COSINE index
  });
}

// ── Insert ────────────────────────────────────────────────────────────────────

export async function insertChunks(
  collectionName: string,
  chunks: Array<{ text: string; source: string; category: string; vector: number[] }>
): Promise<void> {
  // REST API accepts up to 100 rows per call — insert in batches
  const BATCH = 50;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    await zillizFetch('/v2/vectordb/entities/insert', {
      collectionName,
      data: batch,
    });
  }
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface SearchResult {
  text: string;
  source: string;
  distance: number;
}

export async function searchCollection(
  collectionName: string,
  vector: number[],
  topK: number,
  filter?: string
): Promise<SearchResult[]> {
  const body: Record<string, unknown> = {
    collectionName,
    data: [vector],
    annsField: 'vector',
    limit: topK,
    outputFields: ['text', 'source'],
  };
  if (filter) body.filter = filter;

  const results = await zillizFetch('/v2/vectordb/entities/search', body) as Array<{
    text: string;
    source: string;
    distance: number;
  }>[];

  // REST returns array-of-arrays (one per query vector)
  return (results[0] ?? []) as SearchResult[];
}

// ── Transcript search ─────────────────────────────────────────────────────────

export interface TranscriptResult {
  text: string;
  rep: string;
  geo: string;
  date: string;
  duration: number;
  distance: number;
}

export async function searchTranscripts(
  vector: number[],
  topK: number
): Promise<TranscriptResult[]> {
  const results = await zillizFetch('/v2/vectordb/entities/search', {
    collectionName: 'bds_transcripts',
    data: [vector],
    annsField: 'vector',
    limit: topK,
    outputFields: ['text', 'rep', 'geo', 'date', 'duration'],
  }) as TranscriptResult[][];

  return results[0] ?? [];
}
