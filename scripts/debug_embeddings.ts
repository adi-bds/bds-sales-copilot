/**
 * debug_embeddings.ts — test what chunks get returned for a query
 * Run: npx tsx scripts/debug_embeddings.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import OpenAI from 'openai';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type Chunk = { id: string; source: string; category: string; text: string; embedding: number[] };

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) + 1e-10);
}

async function main() {
  const filePath = path.join(process.cwd(), 'knowledge', 'embeddings.json');
  const { chunks }: { chunks: Chunk[] } = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  console.log(`\nLoaded ${chunks.length} total chunks\n`);

  // Show how many chunks per file
  const bySource = new Map<string, number>();
  for (const c of chunks) {
    bySource.set(c.source, (bySource.get(c.source) ?? 0) + 1);
  }
  console.log('Chunks per file:');
  for (const [src, count] of [...bySource.entries()].sort()) {
    console.log(`  ${src}: ${count} chunks`);
  }

  // Test query
  const query = 'what are the gsm options for a block out fabric';
  console.log(`\nQuery: "${query}"\n`);

  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: query,
  });
  const queryVec = res.data[0].embedding;

  const scored = chunks
    .map(c => ({ chunk: c, score: cosineSimilarity(queryVec, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  console.log('Top 10 chunks:');
  for (const { chunk, score } of scored) {
    console.log(`\n  [score=${score.toFixed(4)}] ${chunk.source} (category: ${chunk.category})`);
    console.log(`  "${chunk.text.slice(0, 200).replace(/\n/g, ' ')}..."`);
  }

  // Also check: does products_banners_printing.md have any chunks with "gsm" in them?
  const gsmChunks = chunks.filter(c =>
    c.source.includes('banners_printing') && /gsm/i.test(c.text)
  );
  console.log(`\nChunks from products_banners_printing.md containing "gsm": ${gsmChunks.length}`);
  for (const c of gsmChunks.slice(0, 3)) {
    console.log(`\n  [${c.id}]`);
    console.log(`  "${c.text.slice(0, 300).replace(/\n/g, ' ')}"`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
