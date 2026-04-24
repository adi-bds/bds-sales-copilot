import Anthropic from '@anthropic-ai/sdk';
import { NextRequest } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const client = new Anthropic();

// ─── Knowledge File Loader ─────────────────────────────────────────────────
// Files are cached in memory after the first read. In serverless environments
// this cache lives for the duration of a warm instance — cold starts re-read
// from disk, which is fast (~ms) for these small markdown files.

const fileCache = new Map<string, string>();

function loadFile(relativePath: string): string {
  if (fileCache.has(relativePath)) return fileCache.get(relativePath)!;

  const fullPath = join(process.cwd(), 'knowledge', relativePath);
  if (!existsSync(fullPath)) {
    console.warn(`[BDS Copilot] Knowledge file not found: ${fullPath}`);
    return '';
  }

  const content = readFileSync(fullPath, 'utf-8');
  fileCache.set(relativePath, content);
  return content;
}

// ─── Retrieval Routing ────────────────────────────────────────────────────
// sales_playbook.md is the only always-load — pricing, discounts, workflow.
// Everything else loads conditionally to keep the context lean and fast.
const ALWAYS_LOAD = [
  'core/sales_playbook.md',
];

type Message = { role: string; content: string };

function detectFilesToLoad(messages: Message[]): string[] {
  // Analyse the last 4 messages for context so multi-turn conversations
  // (e.g. "draft an email for that UK client") carry forward correctly.
  const recentText = messages
    .slice(-4)
    .map((m) => m.content)
    .join(' ')
    .toLowerCase();

  const files = new Set<string>(ALWAYS_LOAD);

  // ── UK detection ──────────────────────────────────────────────────────────
  const isUK =
    /\buk\b|\bbritish\b|britain|england|\bgbp\b|\bpounds?\b|\.co\.uk|backdropsource\.co|kaviya|uk\s+rep|uk\s+team|uk\s+client|uk\s+email/.test(
      recentText
    );

  if (isUK) {
    let ukCount = 0;

    if (/complaint|wrong item|damaged|missing|broken|refund|defect|issue|problem/.test(recentText)) {
      files.add('uk/uk_complaints_playbook.md'); ukCount++;
    }
    if (/objection|too expensive|cheaper|competitor|price.?match|reduce the price|can you do better/.test(recentText)) {
      files.add('uk/uk_objection_playbook.md'); ukCount++;
    }
    if (/mockup|artwork|proof|design|approve|approval|2d|visual/.test(recentText)) {
      files.add('uk/uk_mockup_design_playbook.md'); ukCount++;
    }
    if (/quote|pricing|cost|how much|invoice/.test(recentText)) {
      files.add('uk/uk_quote_playbook.md'); ukCount++;
    }
    if (/follow.?up|check.?in|reorder|repeat.?order|coming back|haven.t heard/.test(recentText)) {
      files.add('uk/uk_followup_reorder_playbook.md'); ukCount++;
    }
    if (/initial|first.?reply|first.?email|inquiry|enquir|new.?client|new.?lead|getting in touch/.test(recentText)) {
      files.add('uk/uk_initial_inquiry_playbook.md'); ukCount++;
    }

    // UK mentioned but no specific stage detected → load summary + initial inquiry
    if (ukCount === 0) {
      files.add('uk/uk_sales_master_summary.md');
      files.add('uk/uk_initial_inquiry_playbook.md');
    }
  }

  // ── Customization rules ───────────────────────────────────────────────────
  if (/custom|size|dimension|width|height|non.?standard|bespoke|can you do|do you make|max size|minimum/.test(recentText)) {
    files.add('core/customization_rules.md');
  }

  // ── Geo / market / order patterns ─────────────────────────────────────────
  if (/australia|canada|new zealand|uae|india|germany|france|spain|market|geo|currency|shipping|seasonal|peak/.test(recentText)) {
    files.add('core/order_patterns.md');
  }

  // ── Product catalog ───────────────────────────────────────────────────────
  if (/\bbooth\b|exhibit|trade.?show|10.?x.?10|20.?x.?10|popup booth|seg.?booth|booth kit/.test(recentText)) {
    files.add('products/products_booth_kits.md');
  }
  if (/media.?wall|backdrop|tension.?fabric|archway|step.?repeat|seamwall|photo wall/.test(recentText)) {
    files.add('products/products_media_walls_backdrops.md');
  }
  if (/\bbanner\b|roll.?up|flag.?banner|hanging.?banner|retractable|pull.?up/.test(recentText)) {
    files.add('products/products_banners_printing.md');
  }
  if (/\bcounter\b|lightbox|light.?box|snap.?frame|display.?case/.test(recentText)) {
    files.add('products/products_counters_displays.md');
  }
  if (/photo.?booth|photo.?studio|table.?cover|backdrop.?stand/.test(recentText)) {
    files.add('products/products_photo_studio.md');
  }
  if (/outdoor|canopy|tent|umbrella|inflat/.test(recentText)) {
    files.add('products/products_outdoor_events.md');
  }
  if (/accessory|accessories|storage.?case|spare.?part|carry.?bag|misc/.test(recentText)) {
    files.add('products/products_other.md');
  }

  // Generic product or recommendation request with no specific category match
  if (/\bproduct\b|recommend|what.?do.?we.?have|what.?do.?we.?sell|catalog|our.?range|what.?options/.test(recentText)) {
    const hasSpecific = [...files].some(
      (f) => f.startsWith('products/') && f !== 'products/products_toc.md'
    );
    if (!hasSpecific) {
      files.add('products/products_toc.md');
      files.add('products/products_booth_kits.md');
      files.add('products/products_media_walls_backdrops.md');
      files.add('products/products_banners_printing.md');
    }
  }

  // ── Client intelligence ───────────────────────────────────────────────────
  if (/\bclient\b|\bcustomer\b|\baccount\b|call.?prep|who.?is|before.?the.?call|their.?history|b2b|previously ordered|same as (before|last time|my last)|reorder|order again|same order|my (last|previous) order|i (ordered|bought) before/.test(recentText)) {
    files.add('core/b2b_customers.md');
  }

  // ── Product knowledge / pitch angles ──────────────────────────────────────
  if (/\bpitch\b|selling.?point|benefit|feature|why.?choose|use.?case|industry|explain.?how|how.?does/.test(recentText)) {
    files.add('core/blog_posts.md');
  }

  const result = [...files];
  console.log(`[BDS Copilot] Files selected (${result.length}):`, result.join(', '));
  return result;
}

// ─── System Prompt Builder ────────────────────────────────────────────────

function buildSystemPrompt(filePaths: string[]): string {
  const knowledgeSections = filePaths
    .map((fp) => {
      const content = loadFile(fp);
      if (!content) return null;
      const label = fp
        .replace(/^(core|products|uk)\//, '')
        .replace(/\.md$/, '')
        .replace(/_/g, ' ')
        .toUpperCase();
      return `## ═══ ${label} ═══\n\n${content}`;
    })
    .filter(Boolean)
    .join('\n\n---\n\n');

  return `${CORE_INSTRUCTIONS}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KNOWLEDGE BASE — loaded for this conversation
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The following reference files have been selected based on the topic of this conversation.
Use them as your primary source of truth — cite them directly rather than guessing.

${knowledgeSections}`;
}

// ─── Core Instructions ────────────────────────────────────────────────────

const CORE_INSTRUCTIONS = `You are the BDS Sales Copilot for Backdropsource (backdropsource.com) — a senior sales specialist helping reps close deals faster.

## Response rules — non-negotiable
- Be brief. Most answers: 3–5 bullet points or 2–3 sentences. No waffle.
- Lead with the answer. Never open with "Great question!" or any filler.
- Emails: write the full email only — no commentary before or after.
- Products: name, price, URL, one-line reason. Max 3 options.
- Unknown spec or price: say "Check Shopify admin." Nothing more.
- Never fabricate product names, prices, or order history.

## Company
- HQ: Dallas TX | India office: Coimbatore
- US warehouses: Grand Prairie TX, Irvine CA | AU: Brisbane | UK: High Peak, Derbyshire
- backdropsource.com | backdropsource.co.uk | sales@backdropsource.com | +1 (650) 614-1888
- Markets: US (USD), Canada (CAD), UK (GBP), AU (AUD), NZ (NZD), UAE (AED), India (INR), EU (EUR)
- Always use the correct currency for the client's market.

## Tone by market
- US/AU/NZ: warm, direct | UK: restrained-warm, first names, answer-first | UAE/DE/FR: formal

## UK clients
Follow the UK playbooks in the knowledge base exactly — they are built from 1,368 real email threads.

## Escalate to manager
Custom pricing, discounts over 10%, order exceptions, complaints requiring refunds.`;

// ─── API Route Handler ────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const { messages } = await req.json();

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response('Invalid request: messages array required', { status: 400 });
    }

    const selectedFiles = detectFilesToLoad(messages as Message[]);
    const systemPrompt = buildSystemPrompt(selectedFiles);

    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: systemPrompt,
      messages: (messages as Message[]).map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    });

    const readableStream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            if (
              chunk.type === 'content_block_delta' &&
              chunk.delta.type === 'text_delta'
            ) {
              controller.enqueue(new TextEncoder().encode(chunk.delta.text));
            }
          }
        } finally {
          controller.close();
        }
      },
    });

    return new Response(readableStream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        'Transfer-Encoding': 'chunked',
      },
    });
  } catch (error) {
    console.error('[BDS Copilot] API error:', error);
    return new Response('Internal server error', { status: 500 });
  }
}
