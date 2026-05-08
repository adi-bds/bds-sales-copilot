/**
 * BDS Knowledge Base Indexer
 *
 * Chunks all markdown knowledge files and indexes them into Milvus
 * using OpenAI text-embedding-3-small embeddings.
 *
 * Run with:
 *   npx ts-node --project tsconfig.scripts.json scripts/index_knowledge.ts
 *
 * Re-run any time knowledge files are updated (new products export, playbook changes, etc.)
 * The script drops and rebuilds the collection fresh each time.
 */

import { MilvusClient, DataType } from '@zilliz/milvus2-sdk-node';
import OpenAI from 'openai';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import * as dotenv from 'dotenv';

// Load .env.local
dotenv.config({ path: join(__dirname, '..', '.env.local') });

const COLLECTION = 'bds_knowledge';
const EMBEDDING_DIM = 1536; // text-embedding-3-small

// Zilliz serverless addresses include "https://" — gRPC client needs just the hostname
const grpcAddress = process.env.MILVUS_ADDRESS!
  .replace(/^https?:\/\//, '')
  .replace(/\/$/, '');

const milvus = new MilvusClient({
  address: grpcAddress,
  token: process.env.MILVUS_TOKEN!,
  timeout: 60000,
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Types ───────────────────────────────────────────────────────────────────

interface Chunk {
  text: string;
  source: string;
  category: string;
}

// ── Chunking ─────────────────────────────────────────────────────────────────
// Product files: split on ### headings — each product = one chunk
// Core/playbook files: keep as one chunk if small, split on ## if large

function chunkMarkdown(content: string, source: string): Chunk[] {
  const category =
    source.startsWith('products/') ? 'product' :
    source.startsWith('uk/')       ? 'playbook' :
                                     'core';

  // For small non-product files, keep as a single chunk
  if (category !== 'product' && content.length < 6000) {
    return [{ text: content.trim(), source, category }];
  }

  // Split on ### or ## headings
  const delimiter = category === 'product' ? /\n(?=###\s)/ : /\n(?=##\s)/;
  const chunks = content
    .split(delimiter)
    .map(c => c.trim())
    .filter(c => c.length > 80);

  return chunks.map(text => ({ text, source, category }));
}

// ── Embedding ─────────────────────────────────────────────────────────────────

async function embed(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 7000),
  });
  return res.data[0].embedding;
}

// ── Collection setup ──────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 5000): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const isTimeout = err instanceof Error && err.message.includes('DEADLINE_EXCEEDED');
      if (isTimeout && attempt < retries) {
        console.log(`  ⏳ Timeout — retrying in ${delayMs / 1000}s (attempt ${attempt}/${retries})...`);
        await sleep(delayMs);
      } else {
        throw err;
      }
    }
  }
  throw new Error('Max retries exceeded');
}

async function ensureCollection(): Promise<void> {
  const exists = await withRetry(() => milvus.hasCollection({ collection_name: COLLECTION }));

  if (exists.value) {
    console.log('⚠️  Collection exists — dropping for fresh rebuild...');
    await withRetry(() => milvus.dropCollection({ collection_name: COLLECTION }));
    await sleep(3000); // brief pause after drop
  }

  await milvus.createCollection({
    collection_name: COLLECTION,
    fields: [
      {
        name: 'id',
        data_type: DataType.Int64,
        is_primary_key: true,
        autoID: true,
      },
      {
        name: 'text',
        data_type: DataType.VarChar,
        max_length: 8000,
      },
      {
        name: 'source',
        data_type: DataType.VarChar,
        max_length: 200,
      },
      {
        name: 'category',
        data_type: DataType.VarChar,
        max_length: 50,
      },
      {
        name: 'vector',
        data_type: DataType.FloatVector,
        dim: EMBEDDING_DIM,
      },
    ],
  });

  await milvus.createIndex({
    collection_name: COLLECTION,
    field_name: 'vector',
    index_type: 'AUTOINDEX',
    metric_type: 'COSINE',
  });

  await milvus.loadCollection({ collection_name: COLLECTION });
  console.log('✅ Collection created and loaded.\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

// ── Zilliz warmup — wake the cluster before any gRPC calls ───────────────────
// Free tier clusters suspend after inactivity. The REST API wakes them faster
// than gRPC, so we ping it first and wait until it responds, then proceed.

async function warmupCluster(): Promise<void> {
  const address = process.env.MILVUS_ADDRESS!;
  const token   = process.env.MILVUS_TOKEN!;

  // Normalize address to a clean base URL (handles both formats):
  //   "https://in03-xxxx.serverless.aws-eu-central-1.cloud.zilliz.com"  (already has protocol)
  //   "in03-xxxx.api.gcp-us-west1.zillizcloud.com:443"                  (gRPC style)
  const base = address.startsWith('http')
    ? address.replace(/\/$/, '')
    : `https://${address.replace(/:443$/, '')}`;
  const url  = `${base}/v2/vectordb/collections/list`;

  console.log('⏳ Warming up Zilliz cluster (REST ping)...');

  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ dbName: 'default' }),
        signal: AbortSignal.timeout(20000),
      });

      if (res.ok || res.status === 200) {
        const data = await res.json() as { code: number };
        if (data.code === 0) {
          console.log(`✅ Cluster is awake (attempt ${attempt})\n`);
          return;
        }
      }
      console.log(`  Attempt ${attempt}: status ${res.status} — waiting 5s...`);
    } catch (err) {
      console.log(`  Attempt ${attempt}: ${(err as Error).message} — waiting 5s...`);
    }
    await sleep(5000);
  }
  console.warn('⚠️  Could not confirm cluster is awake — proceeding anyway...\n');
}

async function main(): Promise<void> {
  console.log('🚀 BDS Knowledge Base Indexer\n');

  // Validate env vars
  if (!process.env.MILVUS_ADDRESS || !process.env.MILVUS_TOKEN || !process.env.OPENAI_API_KEY) {
    console.error('❌ Missing env vars. Check MILVUS_ADDRESS, MILVUS_TOKEN, OPENAI_API_KEY in .env.local');
    process.exit(1);
  }

  // Wake cluster before attempting gRPC operations
  await warmupCluster();

  await ensureCollection();

  const knowledgeDir = join(__dirname, '..', 'knowledge');
  const folders = ['core', 'products', 'uk'];

  let totalFiles = 0;
  let totalChunks = 0;

  for (const folder of folders) {
    const folderPath = join(knowledgeDir, folder);
    if (!existsSync(folderPath)) {
      console.log(`  Skipping ${folder}/ — folder not found`);
      continue;
    }

    const files = readdirSync(folderPath).filter(f => f.endsWith('.md'));
    console.log(`📁 ${folder}/ — ${files.length} files`);

    for (const file of files) {
      const source = `${folder}/${file}`;
      const content = readFileSync(join(folderPath, file), 'utf-8');
      const chunks = chunkMarkdown(content, source);

      process.stdout.write(`  ${source} → ${chunks.length} chunks ... `);

      for (const chunk of chunks) {
        const vector = await embed(chunk.text);
        await milvus.insert({
          collection_name: COLLECTION,
          data: [{
            text: chunk.text,
            source: chunk.source,
            category: chunk.category,
            vector,
          }],
        });
        totalChunks++;
      }

      console.log('✓');
      totalFiles++;
    }

    console.log('');
  }

  console.log(`\n✅ Done. Indexed ${totalFiles} files → ${totalChunks} chunks into Milvus.`);
  console.log('You can now deploy the app — Milvus retrieval is live.\n');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Indexer failed:', err);
  process.exit(1);
});
