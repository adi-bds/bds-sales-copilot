/**
 * build_embeddings.ts
 *
 * One-time (or on knowledge update) script that:
 *  1. Reads all .md files in /knowledge
 *  2. Splits them into ~500-char overlapping chunks
 *  3. Calls OpenAI text-embedding-3-small for each chunk
 *  4. Saves everything to knowledge/embeddings.json
 *
 * Run with:
 *   npx tsx scripts/build_embeddings.ts
 *
 * Commit the resulting embeddings.json — it replaces Milvus entirely.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import OpenAI from 'openai';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Chunking config ──────────────────────────────────────────────────────────
const CHUNK_SIZE = 500;   // characters per chunk
const CHUNK_OVERLAP = 100; // overlap between chunks so context isn't lost at boundaries

// ─── Category mapping ─────────────────────────────────────────────────────────
function getCategory(relativePath: string): string {
  if (relativePath.startsWith('uk/')) return 'uk';
  if (relativePath.startsWith('products/')) return 'product';
  if (relativePath.includes('playbook') || relativePath.includes('sales') || relativePath.includes('insights')) return 'playbook';
  return 'core';
}

// ─── Chunker ─────────────────────────────────────────────────────────────────
function chunkText(text: string, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 50) { // skip tiny leftover chunks
      chunks.push(chunk);
    }
    start += chunkSize - overlap;
  }

  return chunks;
}

// ─── Embed with retry ─────────────────────────────────────────────────────────
async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
  });
  return res.data.map(d => d.embedding);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const knowledgeDir = path.join(process.cwd(), 'knowledge');
  const outputPath = path.join(knowledgeDir, 'embeddings.json.gz');

  // Collect all .md files
  const allFiles: string[] = [];
  function walk(dir: string, base: string) {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const rel = path.join(base, entry);
      if (fs.statSync(full).isDirectory()) {
        walk(full, rel);
      } else if (entry.endsWith('.md')) {
        allFiles.push(rel);
      }
    }
  }
  walk(knowledgeDir, '');

  console.log(`\n📚 Found ${allFiles.length} knowledge files\n`);

  type Chunk = {
    id: string;
    source: string;
    category: string;
    text: string;
    embedding: number[];
  };

  const allChunks: Chunk[] = [];
  let totalChunks = 0;

  for (const relPath of allFiles) {
    const fullPath = path.join(knowledgeDir, relPath);
    const text = fs.readFileSync(fullPath, 'utf-8');
    const chunks = chunkText(text);
    const category = getCategory(relPath);

    console.log(`  ${relPath} → ${chunks.length} chunks`);
    totalChunks += chunks.length;

    // Embed in batches of 20 (OpenAI allows up to 2048 but let's be conservative)
    const BATCH_SIZE = 20;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const embeddings = await embedBatch(batch);

      for (let j = 0; j < batch.length; j++) {
        allChunks.push({
          id: `${relPath}::${i + j}`,
          source: relPath,
          category,
          text: batch[j],
          embedding: embeddings[j],
        });
      }

      // Brief pause to stay well within OpenAI rate limits
      if (i + BATCH_SIZE < chunks.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }

  // ─── Call summaries ──────────────────────────────────────────────────────────
  const summariesPath = path.join(knowledgeDir, 'call_summaries.jsonl');
  if (fs.existsSync(summariesPath)) {
    const lines = fs.readFileSync(summariesPath, 'utf-8').split('\n').filter(Boolean);
    console.log(`\n📞 Embedding ${lines.length} call summaries...`);

    const BATCH_SIZE = 20;
    for (let i = 0; i < lines.length; i += BATCH_SIZE) {
      const batch = lines.slice(i, i + BATCH_SIZE).map(line => {
        const s = JSON.parse(line);
        // Groq sometimes returns strings instead of arrays — normalise both
        const toArr = (v: unknown): string[] =>
          Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : [];
        // Convert summary object to a natural-language string for embedding
        return [
          `Rep: ${s.rep} | Geo: ${s.geo} | Date: ${s.date} | Duration: ${s.duration_mins}min`,
          `Topic: ${s.topic}`,
          `Products discussed: ${toArr(s.products_discussed).join(', ') || 'none'}`,
          `Objections: ${toArr(s.objections).join('; ') || 'none'}`,
          `How handled: ${s.how_handled}`,
          `Outcome: ${s.outcome}`,
          `Sentiment: ${s.sentiment}`,
          `Complaint: ${s.complaint ? 'yes' : 'no'} | Price discussed: ${s.price_discussed ? 'yes' : 'no'} | Competitor pricing mentioned: ${s.competitor_pricing ? 'yes' : 'no'}`,
          `Key quote: "${s.key_quote}"`,
        ].join('\n');
      });

      const embeddings = await embedBatch(batch);
      for (let j = 0; j < batch.length; j++) {
        allChunks.push({
          id: `call_summary::${i + j}`,
          source: 'call_summaries.jsonl',
          category: 'transcript',
          text: batch[j],
          embedding: embeddings[j],
        });
      }
      totalChunks += batch.length;

      if (i % 200 === 0) console.log(`  ... ${i}/${lines.length} summaries embedded`);
      await new Promise(r => setTimeout(r, 200));
    }
    console.log(`✅ Call summaries embedded`);
  } else {
    console.log('\n⚠️  No call_summaries.jsonl found — skipping transcript embedding');
  }

  console.log(`\n✅ Embedded ${totalChunks} total chunks`);

  const json = JSON.stringify({ chunks: allChunks }, null, 0);
  const compressed = zlib.gzipSync(Buffer.from(json, 'utf-8'), { level: 6 });
  fs.writeFileSync(outputPath, compressed);

  const fileSizeKB = Math.round(fs.statSync(outputPath).size / 1024);
  console.log(`💾 Saved to knowledge/embeddings.json.gz (${fileSizeKB} KB compressed)`);
  console.log('\nNext steps:');
  console.log('  1. Add USE_BUNDLED_EMBEDDINGS=true to .env.local');
  console.log('  2. npm run dev\n');
}

main().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
