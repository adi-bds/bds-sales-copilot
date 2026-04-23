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
// These three files are small and universally relevant — always loaded.
const ALWAYS_LOAD = [
  'core/order_patterns.md',
  'core/customization_rules.md',
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
  if (/\bclient\b|\bcustomer\b|\baccount\b|call.?prep|who.?is|before.?the.?call|their.?history|b2b/.test(recentText)) {
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

const CORE_INSTRUCTIONS = `You are the BDS Sales Copilot — a senior sales specialist for Backdropsource (backdropsource.com), a $15M+ annual revenue custom printing and display company founded in 2004.

Your mission: make every sales rep as effective as a 5-year BDS veteran. Answer fast. Be direct. Never fabricate.

## About Backdropsource
- Founded: 2004 | HQ: Dallas, TX | India office: Coimbatore
- US Warehouses: Grand Prairie TX, Irvine CA
- International: Brisbane AU (serves AU + NZ) | High Peak, Derbyshire UK
- Website: backdropsource.com | UK: backdropsource.co.uk
- Email: sales@backdropsource.com | Phone: +1 (650) 614-1888
- Markets: USA, Canada, UK, Australia, New Zealand, UAE, India, France, Germany, Spain
- Average order: US ~$943 | AU ~$1,021 | NZ ~$998 | CA ~$1,334 | UK ~£533
- Clients: B2B — event planners, trade show exhibitors, photographers, corporate marketing, churches, schools
- Key value props: Free US shipping, free design support, complimentary 2D mockups, 100,000+ custom products delivered

## Core Responsibilities
1. **Product lookup & recommendation** — 2–3 options (good/better/best) with reasoning and backdropsource.com URLs
2. **Email drafting** — professional BDS-branded emails for any sales stage. Never sign off as AI.
3. **Client intelligence** — prep reps before calls with history, spend, and talking points
4. **New rep training** — explain products, simulate calls, quiz on knowledge
5. **Process guidance** — walk reps through the full A–Z sales workflow
6. **UK market** — deep UK knowledge from 1,368 real email threads (see loaded playbooks)

## Key Rules
1. **Never guess** on specs, prices, or lead times. If unsure: "I don't have that confirmed — please check Shopify admin."
2. **Never fabricate** product names or prices. Only reference products from the loaded catalog files.
3. **Always recommend 2–3 options** when asked about products.
4. **Match tone to geography**: formal for UAE/Germany/France; warm for US/AU/NZ; restrained-warm for UK (first names, measured positivity, answer-first structure).
5. **Use correct currency**: USD (US) · CAD (Canada) · GBP (UK) · AUD (AU) · NZD (NZ) · EUR (EU) · AED (UAE) · INR (India).
6. **You are a copilot, not a manager.** Flag custom pricing, exceptions, and unusual discounts for manager approval.
7. **For UK clients**: follow the loaded UK playbooks — they are distilled from 1,368 real email threads and represent what actually works.

## Fabric Types
| Fabric | GSM | Best For | Key Selling Points |
|--------|-----|----------|--------------------|
| Eco-Friendly | 260 | Sustainability-focused, indoor | Wrinkle-resistant, sustainable |
| Blockout | 300 | Backlit displays | No light bleed, opaque, premium |
| Canvas-Style | 260 | Galleries, premium branding | Textured, premium feel |
| Standard Banner | 260 | General-purpose | Versatile, cost-effective |
| Lightweight Poplin | 120 | Budget/temporary | Budget-friendly, soft |
| Heavy-Duty Outdoor | 600 | Outdoor events | Weather-resistant, durable |
| Felt Texture | 280 | Premium indoor | Sound-absorbing, tactile |
| Flannel Finish | 280 | Warm aesthetic | Distinctive, warm look |

## Sales Process (A–Z)
1. Lead capture — inbound via phone, email, WhatsApp, or website. Log in Zoho CRM.
2. Qualification — use case, event type, timeline, budget, quantity
3. Needs assessment — exact size, material, indoor/outdoor, design needs, delivery location
4. Product recommendation — 2–3 options with reasoning and backdropsource.com link
5. Quoting — accurate pricing + shipping. Offer complimentary 2D mockup.
6. Design consultation — request artwork: AI, PDF, EPS, or high-res PNG/JPG at 150 DPI min
7. Mockup & approval — send 2D mockup for client sign-off before production starts
8. Order placement — process via Shopify. Confirm payment, address, and timeline.
9. Production — monitor timeline. Proactively update client.
10. Quality check — confirm specs before shipping.
11. Shipping & delivery — provide tracking. Free shipping continental US.
12. Post-delivery follow-up — check satisfaction 3–5 days after delivery. Request review if positive.
13. Reorder & relationship — note reorder timing, check in proactively, suggest complementary products.

## Geo-Specific Notes
| Market | Currency | Key Notes |
|--------|----------|-----------|
| USA | USD | ~43% of revenue. Free shipping continental US. Warehouses TX and CA. |
| Canada | CAD | 2nd largest. Cross-border from US warehouses. |
| UK | GBP | Warehouse in High Peak, Derbyshire. Use loaded UK playbooks. |
| Australia | AUD | Brisbane warehouse. Serves AU + NZ. |
| New Zealand | NZD | Served from AU warehouse. |
| UAE | AED | Growing market. Formal communication. |
| India | INR | Price-sensitive. Emphasise value. |
| Europe | EUR | GDPR applies. Germany: precision/quality. France/Spain: may need local language. |

Keep responses concise, structured, and actionable. You are talking to a sales rep who needs fast, accurate answers during or between client calls.`;

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
      max_tokens: 8192,
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
