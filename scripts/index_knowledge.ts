/**
 * BDS Knowledge Base Indexer — REST API version
 *
 * Uses Zilliz REST API directly (no gRPC SDK) because Zilliz Serverless
 * clusters only support REST from external connections.
 *
 * Run with:
 *   npx ts-node --project tsconfig.scripts.json scripts/index_knowledge.ts
 */

import OpenAI from 'openai';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: join(__dirname, '..', '.env.local') });

const COLLECTION    = 'bds_knowledge';
const EMBEDDING_DIM = 1536;

// ── Zilliz REST client ────────────────────────────────────────────────────────

const BASE_URL = (() => {
  const addr = process.env.MILVUS_ADDRESS ?? '';
  return addr.startsWith('http') ? addr.replace(/\/$/, '') : `https://${addr}`;
})();

const TOKEN = process.env.MILVUS_TOKEN ?? '';

async function zilliz(path: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  const data = await res.json() as { code: number; message?: string; data?: unknown };
  if (data.code !== 0) {
    throw new Error(`Zilliz error ${data.code}: ${data.message ?? JSON.stringify(data)}`);
  }
  return data.data;
}

// ── OpenAI embeddings ─────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function embed(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 7000),
  });
  return res.data[0].embedding;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Types ─────────────────────────────────────────────────────────────────────

interface Chunk {
  text: string;
  source: string;
  category: string;
}

// ── Chunking ──────────────────────────────────────────────────────────────────
//
// Target: ~2,500 chars per chunk (~625 tokens).
// At topK=5 that's ~3,000 tokens of knowledge context — cheap and focused.
// Chunks that exceed MAX_CHUNK_CHARS are split further on blank-line boundaries.

const MAX_CHUNK_CHARS = 2500;

function splitOnParagraphs(text: string, source: string, category: string): Chunk[] {
  if (text.length <= MAX_CHUNK_CHARS) return [{ text, source, category }];

  const chunks: Chunk[] = [];
  let current = '';

  for (const para of text.split(/\n\n+/)) {
    if (current.length + para.length + 2 > MAX_CHUNK_CHARS && current.length > 200) {
      chunks.push({ text: current.trim(), source, category });
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }
  if (current.trim().length > 80) chunks.push({ text: current.trim(), source, category });
  return chunks;
}

function chunkMarkdown(content: string, source: string): Chunk[] {
  const category =
    source.startsWith('products/') ? 'product' :
    source.startsWith('uk/')       ? 'playbook' :
                                     'core';

  // Split on section headers first, then apply MAX_CHUNK_CHARS sub-splitting
  const delimiter = category === 'product' ? /\n(?=###\s)/ : /\n(?=##\s)/;
  const sections = content
    .split(delimiter)
    .map(c => c.trim())
    .filter(c => c.length > 80);

  // For small non-product files, keep as a single chunk
  if (category !== 'product' && content.length < MAX_CHUNK_CHARS) {
    return [{ text: content.trim(), source, category }];
  }

  return sections.flatMap(section => splitOnParagraphs(section, source, category));
}

// ── Collection setup ──────────────────────────────────────────────────────────

async function ensureCollection(): Promise<void> {
  // Check if exists
  const collections = await zilliz('/v2/vectordb/collections/list', { dbName: 'default' }) as string[];

  if (collections.includes(COLLECTION)) {
    console.log('⚠️  Collection exists — dropping for fresh rebuild...');
    await zilliz('/v2/vectordb/collections/drop', { collectionName: COLLECTION });

    // Poll until gone from the list. The list endpoint can be cached so even
    // after the collection disappears from the list, Zilliz may still reject
    // a create with "duplicate parameters". We add an extra 10s buffer after
    // the list confirms it's gone to let the underlying metadata settle.
    process.stdout.write('   Waiting for drop to propagate');
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      process.stdout.write('.');
      const after = await zilliz('/v2/vectordb/collections/list', { dbName: 'default' }) as string[];
      if (!after.includes(COLLECTION)) break;
    }
    process.stdout.write(' listed as gone, settling');
    await sleep(10000); // extra buffer for metadata propagation
    console.log(' ✓\n');
  }

  // Create with schema — retry if Zilliz metadata is still settling.
  // NOTE: `dimension` at the top level auto-creates the vector index using
  // `metricType`. Do NOT also pass `indexParams` — that tries to create a
  // second index on the same field and throws Zilliz error 65535.
  const createBody = {
    collectionName: COLLECTION,
    dimension: EMBEDDING_DIM,
    metricType: 'COSINE',
    primaryFieldName: 'id',
    vectorFieldName: 'vector',
    schema: {
      autoId: true,
      fields: [
        { fieldName: 'id',       dataType: 'Int64',       isPrimary: true, autoId: true },
        { fieldName: 'text',     dataType: 'VarChar',     elementTypeParams: { max_length: '65535' } },
        { fieldName: 'source',   dataType: 'VarChar',     elementTypeParams: { max_length: '200'  } },
        { fieldName: 'category', dataType: 'VarChar',     elementTypeParams: { max_length: '50'   } },
        { fieldName: 'vector',   dataType: 'FloatVector', elementTypeParams: { dim: String(EMBEDDING_DIM) } },
      ],
    },
  };

  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await zilliz('/v2/vectordb/collections/create', createBody);
      console.log('✅ Collection created.\n');
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < 6 && msg.includes('duplicate collection')) {
        console.log(`   Create attempt ${attempt}/6 — still propagating, waiting 10s...`);
        await sleep(10000);
      } else {
        throw err;
      }
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🚀 BDS Knowledge Base Indexer (REST)\n');

  if (!process.env.MILVUS_ADDRESS || !process.env.MILVUS_TOKEN || !process.env.OPENAI_API_KEY) {
    console.error('❌ Missing env vars: MILVUS_ADDRESS, MILVUS_TOKEN, OPENAI_API_KEY');
    process.exit(1);
  }

  console.log(`📡 Connecting to: ${BASE_URL}`);

  // Quick connectivity check
  try {
    await zilliz('/v2/vectordb/collections/list', { dbName: 'default' });
    console.log('✅ Zilliz REST API reachable\n');
  } catch (err) {
    console.error('❌ Cannot reach Zilliz:', err);
    process.exit(1);
  }

  await ensureCollection();

  const knowledgeDir = join(__dirname, '..', 'knowledge');
  const folders = ['core', 'products', 'uk'];

  let totalFiles  = 0;
  let totalChunks = 0;
  const allChunks: (Chunk & { vector: number[] })[] = [];

  // ── Embed all chunks first ──
  for (const folder of folders) {
    const folderPath = join(knowledgeDir, folder);
    if (!existsSync(folderPath)) { console.log(`  Skipping ${folder}/ — not found`); continue; }

    const files = readdirSync(folderPath).filter(f => f.endsWith('.md'));
    console.log(`📁 ${folder}/ — ${files.length} files`);

    for (const file of files) {
      const source = `${folder}/${file}`;
      const content = readFileSync(join(folderPath, file), 'utf-8');
      const chunks = chunkMarkdown(content, source);

      process.stdout.write(`  ${source} → ${chunks.length} chunks ... `);

      for (const chunk of chunks) {
        const vector = await embed(chunk.text);
        allChunks.push({ ...chunk, vector });
        totalChunks++;
        await sleep(30); // gentle rate limiting
      }

      console.log('✓');
      totalFiles++;
    }
    console.log('');
  }

  // ── Insert in batches of 50 ──
  console.log(`\n📤 Inserting ${totalChunks} chunks into Zilliz...`);
  const BATCH = 50;
  for (let i = 0; i < allChunks.length; i += BATCH) {
    const batch = allChunks.slice(i, i + BATCH);
    await zilliz('/v2/vectordb/entities/insert', {
      collectionName: COLLECTION,
      data: batch.map(c => ({
        text: c.text,
        source: c.source,
        category: c.category,
        vector: c.vector,
      })),
    });
    process.stdout.write(`  ${Math.min(i + BATCH, allChunks.length)}/${totalChunks}\r`);
  }

  console.log(`\n\n✅ Done. Indexed ${totalFiles} files → ${totalChunks} chunks.`);
  console.log('Knowledge base is live — deploy to Vercel and test.\n');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Indexer failed:', err);
  process.exit(1);
});
