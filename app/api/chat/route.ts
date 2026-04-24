import Anthropic from '@anthropic-ai/sdk';
import { NextRequest } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const client = new Anthropic();

// ─── Knowledge File Loader ─────────────────────────────────────────────────
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

// ─── Order Lookup ──────────────────────────────────────────────────────────

type OrderItem = { qty: string; name: string; price: string; sku: string };
type Order = {
  order: string;
  date: string;
  email: string;
  customer: string;
  company: string;
  city: string;
  state: string;
  phone: string;
  total: string;
  currency: string;
  financial_status: string;
  fulfillment_status: string;
  discount_code: string;
  discount_amount: string;
  items: OrderItem[];
};
type OrderIndex = {
  orders: Record<string, Order>;
  by_email: Record<string, string[]>;
  by_name: Record<string, string[]>;
};

let ordersIndex: OrderIndex | null = null;

function loadOrdersIndex(): OrderIndex {
  if (ordersIndex) return ordersIndex;
  const path = join(process.cwd(), 'knowledge', 'orders', 'orders_index.json');
  if (!existsSync(path)) {
    console.warn('[BDS Copilot] orders_index.json not found');
    ordersIndex = { orders: {}, by_email: {}, by_name: {} };
    return ordersIndex;
  }
  ordersIndex = JSON.parse(readFileSync(path, 'utf-8')) as OrderIndex;
  console.log(`[BDS Copilot] Orders index loaded: ${Object.keys(ordersIndex.orders).length} orders`);
  return ordersIndex;
}

function lookupOrders(messages: Message[]): string {
  const recentRaw = messages.slice(-4).map((m) => m.content).join(' ');
  const recentLow = recentRaw.toLowerCase();

  // Only run order lookup when the conversation hints at order/customer history
  if (
    !/order|#\d{4,}|us#|au#|eu#|nz#|ca#|previously|reorder|last order|same order|what did|who is|who'?s|history|i ordered|i bought/.test(
      recentLow
    )
  ) {
    return '';
  }

  const index = loadOrdersIndex();
  const found = new Map<string, Order>();

  // 1. Match all regional order numbers: US#16111, AU#20244, EU#18959, NZ#3643, CA#6570
  const orderNumRe = /\b(us|au|eu|nz|ca)#?(\d{4,6})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = orderNumRe.exec(recentRaw)) !== null) {
    const key = `${m[1].toUpperCase()}#${m[2]}`;
    if (index.orders[key]) found.set(key, index.orders[key]);
  }
  // Bare #XXXXX — try all region prefixes
  const bareHashRe = /(?<![a-zA-Z])#(\d{4,6})\b/g;
  while ((m = bareHashRe.exec(recentRaw)) !== null) {
    for (const prefix of ['US', 'AU', 'EU', 'NZ', 'CA']) {
      const key = `${prefix}#${m[1]}`;
      if (index.orders[key]) found.set(key, index.orders[key]);
    }
  }

  // 2. Match by email address
  const emailRe = /[\w.+-]+@[\w.-]+\.\w+/g;
  while ((m = emailRe.exec(recentRaw)) !== null) {
    const email = m[0].toLowerCase();
    (index.by_email[email] || []).forEach((n) => {
      if (index.orders[n]) found.set(n, index.orders[n]);
    });
  }

  // 3. Match by name — check all two-word combinations from recent text
  // against the name index (case-insensitive). Works regardless of how
  // the rep types the name (all lower, Title Case, ALL CAPS, etc.)
  const wordTokens = recentRaw.toLowerCase().match(/\b[a-z]{2,}\b/g) || [];
  for (let wi = 0; wi < wordTokens.length - 1; wi++) {
    const key = `${wordTokens[wi]} ${wordTokens[wi + 1]}`;
    (index.by_name[key] || []).forEach((n) => {
      if (index.orders[n]) found.set(n, index.orders[n]);
    });
  }

  if (found.size === 0) return '';

  // Group by customer (email or name) and sort most recent first
  const byCustomer = new Map<string, Order[]>();
  for (const order of found.values()) {
    const key = order.email || order.customer.toLowerCase();
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key)!.push(order);
  }

  const lines: string[] = ['## ═══ ORDER HISTORY (SHOPIFY) ═══\n'];
  for (const orders of byCustomer.values()) {
    orders.sort((a, b) => b.date.localeCompare(a.date));
    const first = orders[0];
    lines.push(
      `**${first.customer}**${first.company ? ` — ${first.company}` : ''}`
    );
    lines.push(
      `Email: ${first.email} | Phone: ${first.phone || 'n/a'} | ${first.city}, ${first.state}`
    );
    lines.push(`Total orders on file: ${orders.length}\n`);
    for (const o of orders) {
      lines.push(
        `${o.order} | ${o.date} | $${o.total} | ${o.fulfillment_status}${o.discount_code ? ` | discount: ${o.discount_code} -$${o.discount_amount}` : ''}`
      );
      for (const item of o.items) {
        lines.push(`  • ${item.qty}× ${item.name} @ $${item.price}`);
      }
    }
    lines.push('');
  }

  console.log(
    `[BDS Copilot] Order lookup returned ${found.size} order(s) for ${byCustomer.size} customer(s)`
  );
  return lines.join('\n');
}

// ─── Retrieval Routing ────────────────────────────────────────────────────
const ALWAYS_LOAD = ['core/sales_playbook.md'];

type Message = { role: string; content: string };

function detectFilesToLoad(messages: Message[], category?: string, geo?: string): string[] {
  // Build detection text from recent messages + category/geo hints from the UI
  const categoryHint = [
    category === 'product'  ? 'product recommend catalog' : '',
    category === 'email'    ? 'draft email write' : '',
    category === 'training' ? 'train explain how product' : '',
    category === 'callprep' ? 'client customer account history call prep' : '',
    category === 'geo'      ? 'client order' : '',
    geo === 'uk'  ? 'uk client email' : '',
    geo === 'us'  ? 'us order client' : '',
    geo === 'aus' ? 'australia order client' : '',
    geo === 'nz'  ? 'new zealand order client' : '',
    geo === 'ca'  ? 'canada order client' : '',
  ].filter(Boolean).join(' ');

  const recentText = (messages
    .slice(-4)
    .map((m) => m.content)
    .join(' ') + ' ' + categoryHint)
    .toLowerCase();

  const files = new Set<string>(ALWAYS_LOAD);

  // ── Situation-based playbooks — apply to ALL geos ────────────────────────
  // Built from UK email threads but the rules are universal across all markets.
  let playbookCount = 0;
  if (/complaint|wrong item|damaged|missing|broken|refund|defect|issue|problem/.test(recentText)) {
    files.add('uk/uk_complaints_playbook.md'); playbookCount++;
  }
  if (/objection|too expensive|cheaper|competitor|price.?match|reduce the price|can you do better/.test(recentText)) {
    files.add('uk/uk_objection_playbook.md'); playbookCount++;
  }
  if (/mockup|artwork|proof|design|approve|approval|2d|visual/.test(recentText)) {
    files.add('uk/uk_mockup_design_playbook.md'); playbookCount++;
  }
  if (/quote|pricing|cost|how much|invoice/.test(recentText)) {
    files.add('uk/uk_quote_playbook.md'); playbookCount++;
  }
  if (/follow.?up|check.?in|reorder|repeat.?order|coming back|haven.t heard/.test(recentText)) {
    files.add('uk/uk_followup_reorder_playbook.md'); playbookCount++;
  }
  if (/initial|first.?reply|first.?email|inquiry|enquir|new.?client|new.?lead|getting in touch|just reached out|just emailed/.test(recentText)) {
    files.add('uk/uk_initial_inquiry_playbook.md'); playbookCount++;
  }
  // No specific stage detected → load master summary as general guidance
  if (playbookCount === 0) {
    files.add('uk/uk_sales_master_summary.md');
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

  // Generic product request with no specific category
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

function buildSystemPrompt(filePaths: string[], orderContext: string): string {
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

  const orderSection = orderContext ? `\n\n---\n\n${orderContext}` : '';

  return `${CORE_INSTRUCTIONS}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KNOWLEDGE BASE — loaded for this conversation
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Use these as your primary source of truth — cite directly, never guess.

${knowledgeSections}${orderSection}`;
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
- Order history: if ORDER HISTORY section is present, use it. If not, say "I don't have that order on file — check Shopify admin."

## Company
- HQ: Dallas TX | India office: Coimbatore
- US warehouses: Grand Prairie TX, Irvine CA | AU: Brisbane | UK: High Peak, Derbyshire
- backdropsource.com | backdropsource.co.uk | sales@backdropsource.com | +1 (650) 614-1888
- Markets: US (USD), Canada (CAD), UK (GBP), AU (AUD), NZ (NZD), UAE (AED), India (INR), EU (EUR)
- Always use the correct currency for the client's market.

## Tone by market
- US/AU/NZ: warm, direct | UK: restrained-warm, first names, answer-first | UAE/DE/FR: formal

## Sales playbooks
The playbooks in the knowledge base apply to ALL markets, not just UK. They are built from 1,368 real email threads and cover the right approach for complaints, objections, quotes, mockups, follow-ups, and new inquiries regardless of geo. Adapt tone and currency for the market, but follow the playbook structure exactly.

## Complaint emails — strict sequence (never skip steps)
1. First email: acknowledge + apologise + ask for ONE thing only (photo, missing item confirmation, or bank details). Do NOT offer replacement or refund yet.
2. Second email (after evidence received): offer resolution — Option 1 replacement OR Option 2 refund. Let the client choose.
3. Never promise a specific dispatch date or delivery window until production has confirmed the slot. Use: "5–7 working days from dispatch" only — never "dispatched within 2 days" or similar hard commitments.
4. Subject lines must never promise a resolution that hasn't been confirmed (e.g. never "Replacement Arranged Today" on the first email).
5. Complaint replies must be at least 3–4 sentences. One-line responses signal the client isn't being taken seriously.

## Escalate to manager
Custom pricing, discounts over 10%, order exceptions, complaints over £1,000 or involving safety issues, clients threatening chargebacks or legal action.`;

// ─── Model Selection ──────────────────────────────────────────────────────
// Sonnet: anything requiring tone, nuance, or complex reasoning
// Haiku:  fast factual lookups — order history, product info, geo queries
//
// Rule of thumb: if the rep is going to send this output directly to a client
// → Sonnet. If they're just looking something up → Haiku.

const SONNET = 'claude-sonnet-4-5';
const HAIKU  = 'claude-haiku-4-5-20251001';

function selectModel(messages: Message[], category?: string, geo?: string): string {
  const recentText = messages.slice(-2).map((m) => m.content).join(' ').toLowerCase();

  // Always use Sonnet for these categories — output goes to clients
  if (category === 'email')    return SONNET;
  if (category === 'training') return SONNET;

  // Sonnet for sensitive or nuanced situations regardless of category
  if (/complaint|damaged|wrong item|missing|refund|furious|angry|upset|escalat/.test(recentText)) return SONNET;
  if (/objection|too expensive|cheaper|competitor|price.?match/.test(recentText))                  return SONNET;
  if (/draft|write.*email|email.*write|follow.?up email|reply to/.test(recentText))                return SONNET;
  if (/train|explain|how does|walk me through|why do|what is the difference/.test(recentText))     return SONNET;

  // Haiku for fast lookups — order history, product info, call prep, geo queries
  if (category === 'product')  return HAIKU;
  if (category === 'callprep') return HAIKU;
  if (category === 'geo')      return HAIKU;

  // Haiku for straightforward lookup signals
  if (/order|#\d{4,}|previous|what did|who is|look up|find|how much|price|stock/.test(recentText)) return HAIKU;

  // Default to Sonnet for anything ambiguous
  return SONNET;
}

// ─── API Route Handler ────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const { messages, category, geo } = await req.json();

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response('Invalid request: messages array required', { status: 400 });
    }

    const selectedFiles = detectFilesToLoad(messages as Message[], category, geo);
    const orderContext = lookupOrders(messages as Message[]);
    const systemPrompt = buildSystemPrompt(selectedFiles, orderContext);
    const model = selectModel(messages as Message[], category, geo);

    const stream = await client.messages.stream({
      model,
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
