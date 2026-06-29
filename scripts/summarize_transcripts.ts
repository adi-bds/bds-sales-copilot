/**
 * summarize_transcripts.ts
 *
 * Reads all call transcription JSON files, sends each to Groq for summarization,
 * and saves structured summaries to knowledge/call_summaries.jsonl
 *
 * Run with:
 *   npx tsx scripts/summarize_transcripts.ts
 *
 * Output: knowledge/call_summaries.jsonl (one JSON object per line)
 * Then re-run: npx tsx scripts/build_embeddings.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import Groq from 'groq-sdk';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─────────────────────────────────────────────────────────────────────────────
// ✏️  EDIT THIS PROMPT — this is what gets sent to Groq for every call
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are summarizing sales call transcripts for Backdropsource, a trade show display and backdrop company.

Extract the following from the transcript and respond ONLY with valid JSON — no extra text.

{
  "topic": "one sentence: what was the call about",
  "products_discussed": ["list of any products or product types mentioned"],
  "objections": ["list of any objections or concerns the client raised, or empty array if none"],
  "how_handled": "how the rep addressed objections or moved the conversation forward",
  "outcome": "what happened at the end — order confirmed, follow-up needed, complaint resolved, etc.",
  "sentiment": "positive | neutral | negative",
  "complaint": true or false — was this call primarily about a complaint (damaged goods, wrong order, delivery issue, etc.),
  "price_discussed": true or false — was pricing, cost, discounts, or budget mentioned at any point,
  "competitor_pricing": true or false — did the client mention a competitor's price, compare us to another supplier, or say something like 'I got a cheaper quote elsewhere',
  "key_quote": "one memorable or instructive line from the call (the most useful for training)"
}

If the transcript is too short or unclear to extract useful info, return:
{ "topic": "unclear", "products_discussed": [], "objections": [], "how_handled": "", "outcome": "unclear", "sentiment": "neutral", "complaint": false, "price_discussed": false, "competitor_pricing": false, "key_quote": "" }`;

const USER_PROMPT = (transcript: string) =>
  `Transcript:\n${transcript.slice(0, 3000)}`;
// ─────────────────────────────────────────────────────────────────────────────

// Config
const TRANSCRIPTS_DIR = '/Users/adidevas/BDS/Call Transcriptions/out_fast_fw_transcriptions';
const OUTPUT_FILE = path.join(process.cwd(), 'knowledge', 'call_summaries.jsonl');
const MIN_DURATION_SECONDS = 60; // skip calls shorter than 1 minute
const DELAY_MS = 4500;           // delay between calls to stay within Groq 6000 TPM free tier

type TranscriptFile = {
  source_file: string;
  duration: number;
  text: string;
};

function extractMeta(filePath: string) {
  // Extract rep, geo, date from folder structure:
  // zip-X / REP NAME GEO / Month / DD-MM-YYYY / file.json
  const parts = filePath.split(path.sep);
  const repFolder = parts[parts.length - 4] ?? 'Unknown';
  const dateFolder = parts[parts.length - 2] ?? '';

  // Rep name is everything before the last word if it's a geo code
  const repMatch = repFolder.match(/^(.+?)\s+(USA[-\s]?CA|UK|UAE|AU|CA|USA)$/i);
  const rep = repMatch ? repMatch[1].trim() : repFolder;
  const geo = repMatch ? repMatch[2].toUpperCase().replace(/\s/g, '-') : 'Unknown';

  // Parse date DD-MM-YYYY → YYYY-MM-DD
  const dateMatch = dateFolder.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
  const date = dateMatch
    ? `${dateMatch[3]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[1].padStart(2, '0')}`
    : dateFolder;

  return { rep, geo, date };
}

async function summarise(transcript: string): Promise<Record<string, unknown>> {
  const response = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    max_tokens: 300,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: USER_PROMPT(transcript) },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '{}';
  try {
    return JSON.parse(raw);
  } catch {
    return { topic: 'parse_error', raw_response: raw.slice(0, 200) };
  }
}

async function main() {
  // Collect all JSON files
  const allFiles: string[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.json')) allFiles.push(full);
    }
  }
  walk(TRANSCRIPTS_DIR);

  console.log(`\n📞 Found ${allFiles.length} transcript files`);

  // Filter short calls
  const eligible = allFiles.filter(f => {
    try {
      const data: TranscriptFile = JSON.parse(fs.readFileSync(f, 'utf-8'));
      return (data.duration ?? 0) >= MIN_DURATION_SECONDS && (data.text ?? '').length > 100;
    } catch { return false; }
  });

  console.log(`⏱  Skipping calls < ${MIN_DURATION_SECONDS}s — processing ${eligible.length} calls`);
  console.log(`⏳ Estimated time: ~${Math.round(eligible.length * DELAY_MS / 60000)} minutes\n`);

  // Resume support — skip already processed files
  const done = new Set<string>();
  if (fs.existsSync(OUTPUT_FILE)) {
    const lines = fs.readFileSync(OUTPUT_FILE, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try { done.add(JSON.parse(line).source_file); } catch {}
    }
    console.log(`▶️  Resuming — ${done.size} already done, ${eligible.length - done.size} remaining\n`);
  }

  const out = fs.createWriteStream(OUTPUT_FILE, { flags: 'a' });
  let processed = 0;
  let errors = 0;

  for (const filePath of eligible) {
    const data: TranscriptFile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (done.has(data.source_file)) continue;

    const { rep, geo, date } = extractMeta(filePath);

    try {
      const summary = await summarise(data.text);
      const record = {
        source_file: data.source_file,
        rep,
        geo,
        date,
        duration_mins: Math.round((data.duration / 60) * 10) / 10,
        ...summary,
      };
      out.write(JSON.stringify(record) + '\n');
      processed++;

      if (processed % 10 === 0) {
        console.log(`  ✅ ${processed} done, ${errors} errors — latest: ${rep} ${date}`);
      }

      await new Promise(r => setTimeout(r, DELAY_MS));
    } catch (err: unknown) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ Error on ${filePath}: ${msg}`);
      await new Promise(r => setTimeout(r, DELAY_MS * 2));
    }
  }

  out.end();
  console.log(`\n✅ Done — ${processed} summaries saved to knowledge/call_summaries.jsonl`);
  console.log(`   Errors: ${errors}`);
  console.log('\nNext step: npx tsx scripts/build_embeddings.ts\n');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
