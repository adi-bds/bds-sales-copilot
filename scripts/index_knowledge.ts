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

function chunkMarkdown(content: string, source: string): Chunk[] {
  const category =
    source.startsWith('products/') ? 'product' :
    source.startsWith('uk/')       ? 'playbook' :
                                     'core';

  if (category !== 'product' && content.length < 6000) {
    return [{ text: content.trim(), source, category }];
  }

  const delimiter = category === 'product' ? /\n(?=###\s)/ : /\n(?=##\s)/;
  return content
    .split(delimiter)
    .map(c => c.trim())
    .filter(c => c.length > 80)
    .map(text => ({ text, source, category }));
}

// ── Collection setup ──────────────────────────────────────────────────────────

async function ensureCollection(): Promise<void> {
  // Check if exists
  const collections = await zilliz('/v2/vectordb/collections/list', { dbName: 'default' }) as string[];

  if (collections.includes(COLLECTION)) {
    console.log('⚠️  Collection exists — dropping for fresh rebuild...');
    await zilliz('/v2/vectordb/collections/drop', { collectionName: COLLECTION });

    // Poll until the collection is fully gone — a fixed sleep isn't reliable
    process.stdout.write('   Waiting for drop to propagate');
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      process.stdout.write('.');
      const after = await zilliz('/v2/vectordb/collections/list', { dbName: 'default' }) as string[];
      if (!after.includes(COLLECTION)) break;
    }
    console.log(' gone.\n');
  }

  // Create with schema.
  // NOTE: `dimension` at the top level auto-creates the vector index using
  // `metricType`. Do NOT also pass `indexParams` — that tries to create a
  // second index on the same field and throws Zilliz error 65535.
  await zilliz('/v2/vectordb/collections/create', {
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
  });

  console.log('✅ Collection created.\n');
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
