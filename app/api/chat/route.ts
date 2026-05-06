import Anthropic from '@anthropic-ai/sdk';
import { NextRequest } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { retrieveKnowledge } from '@/lib/milvus';

export const runtime = 'nodejs';
export const maxDuration = 30;

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

  // Only run order lookup when the conversation hints at order/customer history.
  // Keep this broad — reps phrase things many ways.
  if (
    !/order|purchase|bought|#\d{4,}|us#|au#|eu#|nz#|ca#|previously|reorder|last order|same order|what did|who is|who'?s|history|look.?up|pull.?up|find.*client|find.*customer|account for|call prep|their history|past orders|previous orders|has.*ordered|have.*ordered|they.?ve ordered|@[\w.-]+\.\w/.test(
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

  // 3. Match by name — try 2-word AND 3-word consecutive combinations.
  // The index has ~500 three-word names (e.g. "John Paul Linton") so
  // pair-only matching silently misses them.
  const wordTokens = recentRaw.toLowerCase().match(/\b[a-z]{2,}\b/g) || [];
  for (let wi = 0; wi < wordTokens.length - 1; wi++) {
    // 2-word pair
    const pair = `${wordTokens[wi]} ${wordTokens[wi + 1]}`;
    (index.by_name[pair] || []).forEach((n) => {
      if (index.orders[n]) found.set(n, index.orders[n]);
    });
    // 3-word triplet
    if (wi + 2 < wordTokens.length) {
      const triplet = `${wordTokens[wi]} ${wordTokens[wi + 1]} ${wordTokens[wi + 2]}`;
      (index.by_name[triplet] || []).forEach((n) => {
        if (index.orders[n]) found.set(n, index.orders[n]);
      });
    }
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
  // Build detection text from recent messages ONLY — no category/geo hints injected.
  // Category and geo drive explicit file loads below; injecting their keywords into
  // recentText caused expensive files (blog_posts.md, b2b_customers.md) to load on
  // every "hello" typed in the wrong category tab.
  const recentText = messages
    .slice(-4)
    .map((m) => m.content)
    .join(' ')
    .toLowerCase();

  const files = new Set<string>(ALWAYS_LOAD);

  // ── Category-driven loads (explicit — no regex matching) ──────────────────
  // Load the most useful file for the chosen category even when the message
  // text alone wouldn't trigger it.  This replaces the old keyword-hint system.
  if (category === 'training') {
    // Rep is in training mode — give them pitch angles and product context
    files.add('core/blog_posts.md');
    // Always include the full sales & order workflow for training sessions
    files.add('core/rep_workflow.md');
  }
  if (category === 'callprep') {
    // Rep is prepping for a call — load the B2B customer history file
    files.add('core/b2b_customers.md');
  }
  if (category === 'product') {
    // Product category — TOC is added further below after keyword checks
  }
  // Geo-specific order patterns only when the message actually mentions them
  // (geo hint alone is not enough — we don't want to load 20KB for a "hello")

  // ── Situation-based playbooks — apply to ALL geos ────────────────────────
  // Only load when a specific situation is detected — never as a default.
  // The sales_playbook.md already covers general guidance.
  if (/complaint|wrong item|damaged|missing|broken|refund|defect|issue|problem/.test(recentText)) {
    files.add('uk/uk_complaints_playbook.md');
  }
  if (/objection|too expensive|cheaper|competitor|price.?match|reduce the price|can you do better/.test(recentText)) {
    files.add('uk/uk_objection_playbook.md');
  }
  if (/mockup|artwork|proof|design|approve|approval|2d|visual/.test(recentText)) {
    files.add('uk/uk_mockup_design_playbook.md');
  }
  if (/quote|pricing|cost|how much|invoice/.test(recentText)) {
    files.add('uk/uk_quote_playbook.md');
  }
  if (/follow.?up|check.?in|reorder|repeat.?order|coming back|haven.t heard/.test(recentText)) {
    files.add('uk/uk_followup_reorder_playbook.md');
  }
  if (/initial|first.?reply|first.?email|inquiry|enquir|new.?client|new.?lead|getting in touch|just reached out|just emailed/.test(recentText)) {
    files.add('uk/uk_initial_inquiry_playbook.md');
  }

  // ── Rep workflow & process guide ──────────────────────────────────────────
  // Load the full order workflow doc whenever a rep asks about how the process
  // works — delivery times, artwork specs, payments, mockup steps, EORI, etc.
  // Also loads for general "how do I" / "what's the process" training questions.
  if (
    /workflow|process|how.?do.?(?:i|we)|step.?by.?step|onboard|new.?rep|train|training|delivery.?time|lead.?time|business.?day|turnaround|artwork.?spec|dpi|resolution|print.?template|wetransfer|dropbox|draft.?order|payment.?method|remittance|purchase.?order|\bpo\b|payment.?proof|eori|international.?ship|confirmed.?order|goes.?to.?production|mockup.?approved|how.?long.?does.?it.?take|when.?will.*ship|what.?happens.?after|next.?step/.test(
      recentText
    )
  ) {
    files.add('core/rep_workflow.md');
  }

  // ── Discount codes ────────────────────────────────────────────────────────
  // Only load when a client is explicitly pushing back on price or asking for
  // a discount. Never loaded proactively — the AI is instructed not to suggest
  // codes unless the client asks.
  if (/discount|promo|coupon|cheaper|price.?match|better.?price|do.{0,10}better|reduce.{0,10}price|lower.?price|any.?deal|any.?offer|negotiate|best.?price|take.?off|knock.?off/.test(recentText)) {
    files.add('core/discounts.md');
  }

  // ── Customization rules ───────────────────────────────────────────────────
  if (/custom|size|dimension|width|height|non.?standard|bespoke|can you do|do you make|max size|minimum/.test(recentText)) {
    files.add('core/customization_rules.md');
  }

  // ── Geo / market / order patterns ─────────────────────────────────────────
  if (/australia|canada|new zealand|uae|india|germany|france|spain|market|geo|currency|shipping|seasonal|peak/.test(recentText)) {
    files.add('core/order_patterns.md');
  }

  // ── Product catalog — keyword routing ────────────────────────────────────
  // Always load the TOC for product queries so Claude knows what files exist.
  // Then load only the specific file(s) relevant to the query.
  if (category === 'product' || /\bproduct\b|recommend|what.?do.?we.?have|what.?do.?we.?sell|catalog|our.?range|what.?options/.test(recentText)) {
    files.add('products/products_toc.md');
  }

  // Booth kits
  if (/\bbooth\b|exhibit|trade.?show|10.?x.?10|20.?x.?10|popup booth|seg.?booth|booth kit/.test(recentText)) {
    files.add('products/products_booth_kits.md');
  }
  // Media walls & fabric backdrops
  if (/media.?wall|tension.?fabric|archway|step.?repeat|seamwall|photo wall|\bseg\b|\bsego\b|seg.?wall|sego.?display/.test(recentText)) {
    files.add('products/products_media_walls_backdrops.md');
  }
  // Banners & printing (includes scaffolding banners, mesh, vinyl, flags)
  if (/\bbanner\b|roll.?up|flag|hanging|retractable|pull.?up|scaffold|mesh|vinyl print|feather|teardrop/.test(recentText)) {
    files.add('products/products_banners_printing.md');
  }
  // Counters, lightboxes, displays
  if (/\bcounter\b|lightbox|light.?box|snap.?frame|display.?case|podium|\bseg\b|\bsego\b|backlit|led.?box|fabric.?display|modular.?display/.test(recentText)) {
    files.add('products/products_counters_displays.md');
  }
  // Photo studio & table covers
  if (/photo.?booth|photo.?studio|table.?cover|table cloth|table skirt/.test(recentText)) {
    files.add('products/products_photo_studio.md');
  }
  // Outdoor — canopies, tents, flags
  if (/outdoor|canopy|tent|umbrella|inflat|gazebo/.test(recentText)) {
    files.add('products/products_outdoor_events.md');
  }
  // Floral walls, stands, cases, accessories
  if (/floral|flower|botanical|artificial.*wall|event.*wall|flower.*wall|led.*light|backdrop.*stand|stand.*backdrop|carry.?case|hard.?case|storage.?case|spare.?part|carry.?bag|accessory|accessories|tote|podium.?case/.test(recentText)) {
    files.add('products/products_other.md');
  }
  // FIFA World Cup 2026 collection
  if (/fifa|world.?cup|soccer|football.*event|fan.?zone|tifo|stadium.*banner|selfie.*frame|country.*flag/.test(recentText)) {
    files.add('products/products_fifa_2026.md');
  }
  // "backdrop" + stand/frame → only load stand/accessory files, NOT the 54KB media walls file
  if (/\bbackdrop\b/.test(recentText) && /\bstand\b|frame.?only|just.?the.?frame|no.?fabric/.test(recentText)) {
    files.add('products/products_other.md');
    files.add('products/products_banners_printing.md');
  } else if (/\bbackdrop\b/.test(recentText)) {
    // Generic "backdrop" → could be fabric media wall OR floral wall
    files.add('products/products_media_walls_backdrops.md');
    files.add('products/products_other.md');
  }
  // Ambiguous product query → load TOC only so the agent can ask one
  // clarifying question. The rep's follow-up will have specific keywords
  // that route to the right file on the next turn.
  if (category === 'product') {
    const hasSpecific = [...files].some(
      (f) => f.startsWith('products/') && f !== 'products/products_toc.md'
    );
    if (!hasSpecific) {
      files.add('products/products_toc.md');
    }
  }

  // ── B2B client intelligence (Top 200 summary — call prep only) ───────────
  // b2b_customers.md is a strategic summary (revenue tier, discount level,
  // best month) for the top 200 companies. It is NOT order history and must
  // NOT load for general order lookups — those come from orders_index.json
  // via lookupOrders() and are injected as the ORDER HISTORY section.
  // Only load this file when the rep is doing strategic call prep, not when
  // they're asking "what did this customer order?" (which is 99% of queries).
  //
  // Keyword-based loading was removed — it caused b2b_customers.md to load
  // on any message containing "client", "customer", or "account", which made
  // the AI answer from the Top 200 list instead of the 17k-order Shopify index.
  //
  // It loads via explicit category: `callprep` (handled at the top of this fn).

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

// ─── Milvus System Prompt Builder ─────────────────────────────────────────
// Used when MILVUS_ADDRESS is configured — replaces file-based system prompt

function buildSystemPromptMilvus(knowledgeContext: string, orderContext: string): string {
  const knowledgeSection = knowledgeContext
    ? `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nKNOWLEDGE BASE — retrieved for this query\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nUse these as your primary source of truth — cite directly, never guess.\n\n${knowledgeContext}`
    : '';
  const orderSection = orderContext ? `\n\n---\n\n${orderContext}` : '';
  return `${CORE_INSTRUCTIONS}${knowledgeSection}${orderSection}`;
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
- Product name matching: product names in the catalog may differ slightly from what the rep types (e.g. "SEG" vs "SEGO", "LED Light Box" vs "Backlit Lightbox", "Model 1" vs "– Model 1"). If you find a close match, present it directly and confidently as the likely product — never say "that exact product isn't in my catalog" when you have a near-identical match. Just say "Here's what I have:" and show it. Only say "Check Shopify admin" if you genuinely have nothing close.
- Discounts: never volunteer a discount code or suggest a lower price unless the client explicitly asks for one. When they do ask, use the DISCOUNTS section only — do not invent codes.
- Order history: the ORDER HISTORY (SHOPIFY) section is the authoritative source for all individual orders — always use it when present. The B2B CUSTOMERS section is a strategic summary only (revenue tier, top product, best month) and must never be used to answer "what did they order?" questions. If no ORDER HISTORY section is present, say "I don't have that order on file — check Shopify admin."

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

## Product queries — clarify before answering
When a product question is vague and the KNOWLEDGE BASE only contains the product TOC (not full product files), ask ONE short clarifying question to identify the right category. Use the TOC categories to frame it naturally.

When to ask:
- "what backdrops do you have?" → "Are you looking for fabric media walls, floral event walls, or backdrop stands?"
- "do you have anything for outdoor events?" → "Is this for a canopy tent, feather flags, or outdoor banners?"
- "what displays do you sell?" → "Are you after a trade show booth kit, a media wall, or a counter display?"
- "do you have flags?" → "Feather/teardrop flags for outdoor use, or country flags for fan events?"

When NOT to ask — answer directly if the type is already clear:
- "floral backdrop" → load and answer (specific)
- "10x10 booth kit" → load and answer (specific)
- "scaffolding banner" → load and answer (specific)
- "FIFA 2026 products" → load and answer (specific)

Keep the clarifying question to one line. Don't list every possible option — pick the 2–3 most likely ones based on the query.

## Order & workflow process (REP WORKFLOW section)
When the REP WORKFLOW section is loaded, use it as the authoritative source for: delivery timelines, artwork requirements, payment methods (Shopify / PO / remittance), when production starts (payment + approval both required), EORI numbers, mockup/revision process, and tool usage (Streak/Shopify/Trello). Quote specifics directly — e.g. "minimum 150 DPI at full size", "5–7 business days from payment and mockup approval."

## Escalate to manager
Custom pricing, discounts over 10%, order exceptions, complaints over £1,000 or involving safety issues, clients threatening chargebacks or legal action.`;

// ─── Model Selection ──────────────────────────────────────────────────────
// Sonnet: anything requiring tone, nuance, or complex reasoning
// Haiku:  fast factual lookups — order history, product info, geo queries
//
// Rule of thumb: if the rep is going to send this output directly to a client
// → Sonnet. If they're just looking something up → Haiku.

const SONNET = 'claude-sonnet-4-6';

function selectModel(): string {
  return SONNET;
}

// ─── API Route Handler ────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const { messages, category, geo } = await req.json();

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response('Invalid request: messages array required', { status: 400 });
    }

    const orderContext = lookupOrders(messages as Message[]);
    const model = selectModel();

    // ── System prompt: Milvus RAG if configured, else file-based routing ──
    const useMilvus = !!(process.env.MILVUS_ADDRESS && process.env.MILVUS_TOKEN && process.env.OPENAI_API_KEY);
    let systemPrompt: string;

    if (useMilvus) {
      // Build a rich query from the last 4 messages for semantic retrieval
      const recentQuery = (messages as Message[])
        .slice(-4)
        .map((m) => m.content)
        .join(' ');
      const knowledgeContext = await retrieveKnowledge(recentQuery, category);
      systemPrompt = buildSystemPromptMilvus(knowledgeContext, orderContext);
      console.log(`[BDS Copilot] Mode: Milvus RAG | category=${category ?? 'none'}`);
    } else {
      // Fallback: keyword-based file routing (works without Milvus configured)
      const selectedFiles = detectFilesToLoad(messages as Message[], category, geo);
      systemPrompt = buildSystemPrompt(selectedFiles, orderContext);
      console.log(`[BDS Copilot] Mode: file routing | category=${category ?? 'none'}`);
    }

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
          let inputTokens = 0;
          let outputTokens = 0;

          for await (const chunk of stream) {
            if (
              chunk.type === 'content_block_delta' &&
              chunk.delta.type === 'text_delta'
            ) {
              controller.enqueue(new TextEncoder().encode(chunk.delta.text));
            }
            // Capture token counts from the usage events the SDK emits
            if (chunk.type === 'message_start' && chunk.message.usage) {
              inputTokens = chunk.message.usage.input_tokens;
            }
            if (chunk.type === 'message_delta' && chunk.usage) {
              outputTokens = chunk.usage.output_tokens;
            }
          }

          // Append token usage as a hidden JSON block the frontend can parse
          const tokenBlock = `\n\n__USAGE__${JSON.stringify({
            input: inputTokens,
            output: outputTokens,
            model,
          })}__END__`;
          controller.enqueue(new TextEncoder().encode(tokenBlock));
          controller.close();
        } catch (streamErr) {
          console.error('[BDS Copilot] Stream error:', streamErr);
          const msg = streamErr instanceof Error ? streamErr.message : 'Unknown stream error';
          controller.enqueue(new TextEncoder().encode(`⚠️ Error: ${msg}. Please try again.`));
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
