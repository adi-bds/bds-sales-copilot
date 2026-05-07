/**
 * BDS Call Transcript Indexer
 *
 * Indexes 9,321 call transcription JSON files into Milvus.
 * Extracts rep name, geo, date, and full transcript text from each file.
 * Chunks long calls into ~800-token segments for better retrieval.
 *
 * Run with:
 *   npx ts-node --project tsconfig.scripts.json scripts/index_transcripts.ts
 *
 * Optional: index only one rep folder for testing:
 *   FILTER_REP="VINU USA-CA" npx ts-node --project tsconfig.scripts.json scripts/index_transcripts.ts
 */

import { MilvusClient, DataType } from '@zilliz/milvus2-sdk-node';
import OpenAI from 'openai';
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, relative } from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: join(__dirname, '..', '.env.local') });

const COLLECTION = 'bds_transcripts';
const EMBEDDING_DIM = 1536;
const CHUNK_SIZE = 800;   // approximate tokens per chunk
const TRANSCRIPTS_DIR = '/Users/adidevas/BDS/Call Transcriptions/out_fast_fw_transcriptions';
const FILTER_REP = process.env.FILTER_REP || null; // optional: index one rep only

const milvus = new MilvusClient({
  address: process.env.MILVUS_ADDRESS!,
  token: process.env.MILVUS_TOKEN!,
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Types ────────────────────────────────────────────────────────────────────

interface Segment {
  start: number;
  end: number;
  text: string;
  speaker: string;
}

interface TranscriptFile {
  source_file: string;
  language: string;
  duration: number;
  text: string;
  segments: Segment[];
}

// ── Metadata extraction from file path ───────────────────────────────────────
// Path format: zip-N/REP NAME GEO/Month/DD-MM-YYYY/filename.json

function extractMeta(filePath: string): { rep: string; geo: string; date: string; month: string } {
  const parts = filePath.replace(TRANSCRIPTS_DIR + '/', '').split('/');
  // parts[0] = zip-N, parts[1] = Rep Name, parts[2] = Month, parts[3] = Date
  const repRaw = parts[1] || 'Unknown';
  const month  = parts[2] || 'Unknown';
  const date   = parts[3] || 'Unknown';

  // Extract geo from rep name — last word(s) after last space that look like a region code
  const geoMatch = repRaw.match(/(USA|UK|UAE|AUS|CA|NZ|AU)\s*[-–]?\s*(CA|USA|UK|UAE)?/i);
  const geo = geoMatch ? geoMatch[0].trim().toUpperCase() : 'Unknown';
  const rep = repRaw.replace(/[-–]\s*(USA|UK|UAE|AUS|CA|NZ|AU)\s*[-–]?\s*(CA|USA)?/i, '').trim();

  return { rep, geo, date, month };
}

// ── Chunking ─────────────────────────────────────────────────────────────────
// Split transcript text into ~800-token chunks with overlap

function chunkText(text: string, chunkSize = CHUNK_SIZE): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  const overlap = Math.floor(chunkSize * 0.1); // 10% overlap

  for (let i = 0; i < words.length; i += chunkSize - overlap) {
    const chunk = words.slice(i, i + chunkSize).join(' ');
    if (chunk.trim().length > 50) chunks.push(chunk.trim());
  }

  return chunks;
}

// ── Embedding ─────────────────────────────────────────────────────────────────

async function embed(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 7000),
  });
  return res.data[0].embedding;
}

// ── Sleep helper (rate limit safety) ─────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Collection setup ──────────────────────────────────────────────────────────

async function ensureCollection(): Promise<void> {
  const exists = await milvus.hasCollection({ collection_name: COLLECTION });

  if (exists.value) {
    console.log(`Collection "${COLLECTION}" already exists — appending to it.`);
    await milvus.loadCollection({ collection_name: COLLECTION });
    return;
  }

  await milvus.createCollection({
    collection_name: COLLECTION,
    fields: [
      { name: 'id',       data_type: DataType.Int64,       is_primary_key: true, autoID: true },
      { name: 'text',     data_type: DataType.VarChar,     max_length: 8000 },
      { name: 'rep',      data_type: DataType.VarChar,     max_length: 100 },
      { name: 'geo',      data_type: DataType.VarChar,     max_length: 50 },
      { name: 'date',     data_type: DataType.VarChar,     max_length: 50 },
      { name: 'month',    data_type: DataType.VarChar,     max_length: 30 },
      { name: 'duration', data_type: DataType.Float },
      { name: 'source',   data_type: DataType.VarChar,     max_length: 500 },
      { name: 'vector',   data_type: DataType.FloatVector, dim: EMBEDDING_DIM },
    ],
  });

  await milvus.createIndex({
    collection_name: COLLECTION,
    field_name: 'vector',
    index_type: 'AUTOINDEX',
    metric_type: 'COSINE',
  });

  await milvus.loadCollection({ collection_name: COLLECTION });
  console.log(`✅ Collection "${COLLECTION}" created.\n`);
}

// ── Walk transcript files ─────────────────────────────────────────────────────

function walkFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(current: string) {
    const entries = readdirSync(current);
    for (const entry of entries) {
      const fullPath = join(current, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (entry.endsWith('.json')) {
        // Apply rep filter if set — check if the file path contains the rep name
        if (FILTER_REP && !fullPath.includes(FILTER_REP)) continue;
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🎙️  BDS Call Transcript Indexer\n');

  if (!process.env.MILVUS_ADDRESS || !process.env.MILVUS_TOKEN || !process.env.OPENAI_API_KEY) {
    console.error('❌ Missing env vars. Check MILVUS_ADDRESS, MILVUS_TOKEN, OPENAI_API_KEY in .env.local');
    process.exit(1);
  }

  if (!existsSync(TRANSCRIPTS_DIR)) {
    console.error(`❌ Transcripts directory not found: ${TRANSCRIPTS_DIR}`);
    process.exit(1);
  }

  await ensureCollection();

  console.log(`📂 Scanning: ${TRANSCRIPTS_DIR}`);
  if (FILTER_REP) console.log(`🔍 Filtering to rep: ${FILTER_REP}`);

  const files = walkFiles(TRANSCRIPTS_DIR);
  console.log(`📞 Found ${files.length} transcript files\n`);

  let totalChunks = 0;
  let totalFiles = 0;
  let skipped = 0;

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const data: TranscriptFile = JSON.parse(raw);

      // Skip very short calls (under 10 seconds — likely dropped calls)
      if (data.duration < 10) {
        skipped++;
        continue;
      }

      // Skip empty transcripts
      if (!data.text || data.text.trim().length < 20) {
        skipped++;
        continue;
      }

      const meta = extractMeta(filePath);
      const chunks = chunkText(data.text);

      process.stdout.write(`[${i + 1}/${files.length}] ${meta.rep} | ${meta.date} | ${chunks.length} chunks ... `);

      for (const chunk of chunks) {
        const vector = await embed(chunk);
        await milvus.insert({
          collection_name: COLLECTION,
          data: [{
            text: chunk,
            rep: meta.rep,
            geo: meta.geo,
            date: meta.date,
            month: meta.month,
            duration: data.duration,
            source: filePath,
            vector,
          }],
        });
        totalChunks++;

        // Small delay to avoid OpenAI rate limits
        await sleep(50);
      }

      console.log('✓');
      totalFiles++;

    } catch (err) {
      console.log(`⚠️  skipped (parse error)`);
      skipped++;
    }
  }

  console.log(`\n✅ Done.`);
  console.log(`   Indexed: ${totalFiles} transcripts → ${totalChunks} chunks`);
  console.log(`   Skipped: ${skipped} files (too short or empty)`);
  console.log(`\nTranscripts are now searchable in BackdropSource IQ.\n`);
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Indexer failed:', err);
  process.exit(1);
});
