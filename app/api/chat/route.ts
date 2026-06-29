import Groq from 'groq-sdk';
import OpenAI from 'openai';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Anthropic = require('@anthropic-ai/sdk').default ?? require('@anthropic-ai/sdk');
import { NextRequest } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { retrieveKnowledge as retrieveKnowledgeMilvus, retrieveTranscripts as retrieveTranscriptsMilvus } from '@/lib/milvus';
import { retrieveKnowledge as retrieveKnowledgeLocal, retrieveTranscripts as retrieveTranscriptsLocal } from '@/lib/localEmbeddings';

// Switch between bundled embeddings (JSON, free) and Milvus (external service).
// To revert to Milvus: remove USE_BUNDLED_EMBEDDINGS from .env.local
const USE_BUNDLED = process.env.USE_BUNDLED_EMBEDDINGS === 'true';
const retrieveKnowledge = USE_BUNDLED ? retrieveKnowledgeLocal : retrieveKnowledgeMilvus;
const retrieveTranscripts = USE_BUNDLED ? retrieveTranscriptsLocal : retrieveTranscriptsMilvus;

export const runtime = 'nodejs';
export const maxDuration = 30;

// ─── LLM clients ──────────────────────────────────────────────────────────────
// Switch provider via LLM_PROVIDER env var: "groq" | "deepseek" (default: groq)
const LLM_PROVIDER = process.env.LLM_PROVIDER ?? 'groq';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const deepseek = new OpenAI({
  // Fall back to a placeholder so the module loads even if the key isn't set yet.
  // Requests will still fail at call-time with a clear auth error if the key is missing.
  apiKey: process.env.DEEPSEEK_API_KEY ?? 'not-configured',
  baseURL: 'https://api.deepseek.com',
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anthropic = new (Anthropic as any)({
  apiKey: process.env.ANTHROPIC_API_KEY ?? 'not-configured',
});

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
// File-based fallback (used when Milvus returns nothing).
// Budget: keep under ~15K tokens for fast, cheap responses.
//
// Always loaded — small and universally needed (~9K tokens total):
const ALWAYS_FILES = [
  'core/sales_playbook.md',       // 2.4K tokens — pricing, tone, core rules
  'core/customization_rules.md',  // 1.1K tokens — artwork, print specs
  'core/discounts.md',            // 0.7K tokens — discount codes
];

// Loaded by query type (never all at once):
const PLAYBOOK_FILES = [
  'uk/uk_complaints_playbook.md',
  'uk/uk_objection_playbook.md',
  'uk/uk_quote_playbook.md',
  'uk/uk_followup_reorder_playbook.md',
  'uk/uk_initial_inquiry_playbook.md',
  'uk/uk_mockup_design_playbook.md',
];

type Message = { role: string; content: string };

function detectFilesToLoad(messages: Message[], category?: string, geo?: string): string[] {
  const recentText = messages.slice(-4).map((m) => m.content).join(' ').toLowerCase();
  const files = new Set<string>(ALWAYS_FILES);

  // Workflow details — only load when explicitly needed
  if (/delivery|dispatch|artwork|dpi|payment|po |purchase.?order|production|timeline|lead.?time|how.?long|when.?will|workflow/.test(recentText)) {
    files.add('core/rep_workflow.md');
  }

  // Order patterns / insights — only when asked about trends
  if (/trend|common|most.?popular|average.?order|typical|pattern|insight|what do clients/.test(recentText)) {
    files.add('core/call_insights.md');
    files.add('core/order_patterns.md');
  }

  // Sales playbooks — apply to ALL markets, not just UK. Load whenever the query
  // involves a complaint, email draft, quote, objection, follow-up, or inquiry.
  // The UK tone/currency/VAT differences are handled by the system prompt — the
  // underlying process playbooks (how to handle complaints, objections, quotes etc.)
  // are universal and should always be available regardless of geo.
  const needsPlaybooks =
    /complaint|issue|wrong|damaged|missing|refund|replacement|email|write.*email|draft|quote|follow.?up|reorder|inquiry|enquiry|objection|pushback|too.?expensive|cheaper|blind.?ship|express.?ship/.test(recentText);
  if (needsPlaybooks) {
    PLAYBOOK_FILES.forEach(f => files.add(f));
  }

  // B2B customer list — load for call prep only
  if (category === 'callprep' || /call prep|i have a call|client intel|what do we know about/.test(recentText)) {
    files.add('core/b2b_customers.md');
  }

  // Blog posts — load for training or pitch angle questions
  if (category === 'training' || /pitch|angle|how do i sell|why buy|blog|content/.test(recentText)) {
    files.add('core/blog_posts.md');
  }

  // Frames & finishes — load for questions about frame types, finishing methods, fabric specs,
  // graphic attachment, how graphics attach, pop-up walls, arches, booth kits, canopy tents,
  // hanging signs, photo booths, counters, adjustable stands, or any structural product detail
  if (
    category === 'training' ||
    /finish|finishing|pole.?pocket|eyelet|grommet|hemming|pillowcase|velcro|silicone.?edge|\bseg.?finish\b|frame.?type|tubular.?frame|aluminum.?profile|truss.?frame|popup.?frame|hexagonal.?frame|roller.?banner|frame.?spec|tube.?size|tube.?diameter|32mm|43mm|50mm|what.*frame|which.*frame|type of frame|how.*(graphic|fabric).*(attach|fix|connect|go on|mount)|how.*(attach|fix|connect)|graphic.*attach|fabric.*attach|attach.*graphic|attach.*fabric|pop.?up.?wall|fabric.?arch|arch.*tunnel|adjustable.*stand|backdrop.*stand|stand.*carpet|canopy.*tent|hanging.*sign|sky.?tube|photo.?booth.*enclosure|gsm|fabric.?thickness|fabric.?weight|blockout.*gsm|air.?mesh|barrier.?fabric|media.?wall.?fabric|canopy.?fabric|flag.?fabric|what.?fabric|which.?fabric/.test(recentText)
  ) {
    files.add('core/frames_and_finishes.md');
  }

  // Products TOC — always load so agent knows what categories exist
  files.add('products/products_toc.md');

  // ── Product files — keyword-gated (250KB combined, load selectively) ──────

  // Booth kits
  if (/\bbooth\b|exhibit|trade.?show|10.?x.?10|20.?x.?10|popup booth|seg.?booth|booth kit/.test(recentText)) {
    files.add('products/products_booth_kits.md');
  }
  // Media walls & fabric backdrops
  if (/media.?wall|tension.?fabric|archway|step.?repeat|seamwall|photo wall|\bseg\b|\bsego\b|seg.?wall|sego.?display/.test(recentText)) {
    files.add('products/products_media_walls_backdrops.md');
  }
  // Banners, printing & fabric specs (GSM, material weight, fabric type)
  if (/\bbanner\b|roll.?up|hanging|retractable|pull.?up|scaffold|mesh|feather|teardrop|wall.?hanging|\bgsm\b|fabric.?spec|fabric.?weight|material.?spec|polyester|knitted|blockout|flannel|felt.?fabric|dye.?sub/.test(recentText)) {
    files.add('products/products_banners_printing.md');
  }
  // Counters, lightboxes, displays
  if (/\bcounter\b|lightbox|light.?box|snap.?frame|podium|\bseg\b|\bsego\b|backlit|led.?box|fabric.?display|modular.?display/.test(recentText)) {
    files.add('products/products_counters_displays.md');
  }
  // Photo studio & table covers
  if (/photo.?booth|photo.?studio|table.?cover|table.?cloth|table skirt/.test(recentText)) {
    files.add('products/products_photo_studio.md');
  }
  // Outdoor — canopies, tents, flags
  if (/outdoor|canopy|tent|umbrella|inflat|gazebo/.test(recentText)) {
    files.add('products/products_outdoor_events.md');
  }
  // Floral, stands, accessories
  if (/floral|flower|botanical|backdrop.?stand|carry.?case|hard.?case|accessory|accessories/.test(recentText)) {
    files.add('products/products_other.md');
  }
  // FIFA 2026
  if (/fifa|world.?cup|soccer|football.*event|fan.?zone|stadium.*banner|selfie.*frame/.test(recentText)) {
    files.add('products/products_fifa_2026.md');
  }
  // Generic backdrop → media walls + other (stands/floral)
  if (/\bbackdrop\b/.test(recentText)) {
    files.add('products/products_media_walls_backdrops.md');
    files.add('products/products_other.md');
  }
  // Full catalog browse — only when rep explicitly asks for everything
  // Don't trigger on category='product' alone (that's the frontend tab, not a browse intent)
  if (/what.?do.?we.?(have|sell|offer)|full.?catalog|our.?range|full.?range|all.?products|show.?me.?everything/.test(recentText)) {
    files.add('products/products_booth_kits.md');
    files.add('products/products_media_walls_backdrops.md');
    files.add('products/products_banners_printing.md');
    files.add('products/products_counters_displays.md');
    files.add('products/products_photo_studio.md');
    files.add('products/products_outdoor_events.md');
    files.add('products/products_other.md');
    files.add('products/products_fifa_2026.md');
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

// Groq free tier: 6,000 TPM. Reserve ~600 for response + ~200 for user messages.
// That leaves ~5,200 tokens (~20,800 chars) for the system prompt total.
const MAX_SYSTEM_CHARS = 14000; // conservative cap (~3,500 tokens)
const MAX_CHARS_PER_FILE = 5000; // per-file cap so no single file dominates

function buildSystemPrompt(filePaths: string[], orderContext: string): string {
  const knowledgeSections = filePaths
    .map((fp) => {
      let content = loadFile(fp);
      if (!content) return null;
      // Truncate large files so we stay within Groq's token limit
      if (content.length > MAX_CHARS_PER_FILE) {
        content = content.slice(0, MAX_CHARS_PER_FILE) + '\n\n[... truncated for length ...]';
      }
      const label = fp
        .replace(/^(core|products|uk)\//, '')
        .replace(/\.md$/, '')
        .replace(/_/g, ' ')
        .toUpperCase();
      return `## ═══ ${label} ═══\n\n${content}`;
    })
    .filter(Boolean)
    .join('\n\n---\n\n');

  // Final safety cap on the combined knowledge block
  const cappedSections = knowledgeSections.length > MAX_SYSTEM_CHARS
    ? knowledgeSections.slice(0, MAX_SYSTEM_CHARS) + '\n\n[... truncated ...]'
    : knowledgeSections;

  const orderSection = orderContext ? `\n\n---\n\n${orderContext}` : '';

  return `${CORE_INSTRUCTIONS}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KNOWLEDGE BASE — loaded for this conversation
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Use these as your primary source of truth — cite directly, never guess.

${cappedSections}${orderSection}`;
}

// ─── Milvus System Prompt Builder ─────────────────────────────────────────
// Used when MILVUS_ADDRESS is configured — replaces file-based system prompt

function buildSystemPromptMilvus(knowledgeContext: string, orderContext: string, transcriptContext = ''): string {
  const knowledgeSection = knowledgeContext
    ? `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nKNOWLEDGE BASE — retrieved for this query\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nUse these as your primary source of truth — cite directly, never guess.\n\n${knowledgeContext}`
    : '';
  const transcriptSection = transcriptContext
    ? `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nCALL TRANSCRIPT EXAMPLES — real calls from BDS reps\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nThese are real call excerpts. Use them as examples of how reps handle situations in practice.\n\n${transcriptContext}`
    : '';
  const orderSection = orderContext ? `\n\n---\n\n${orderContext}` : '';
  return `${CORE_INSTRUCTIONS}${knowledgeSection}${transcriptSection}${orderSection}`;
}

// ─── Core Instructions ────────────────────────────────────────────────────

const CORE_INSTRUCTIONS = `You are the BDS Sales Copilot for Backdropsource (backdropsource.com) — a senior sales specialist helping reps close deals faster.

## ⚠️ GROUND TRUTH RULE — READ THIS FIRST
You have two knowledge sources and must use them correctly:

**1. General knowledge (your training) — use freely:**
Sales techniques, objection handling, trade show industry knowledge, how fabric printing works, general business writing, market context. This is valuable — use it to give intelligent, well-rounded answers.

**2. BDS-specific facts — KNOWLEDGE BASE only:**
What products BDS sells, pricing, dimensions, GSM values, fabric specs, lead times, discount codes, shipping windows, order history, and any process or policy specific to Backdropsource. For these, the KNOWLEDGE BASE sections below are the ONLY authoritative source. Never use your training data to fill in BDS-specific details — it will be wrong or outdated.

If a BDS-specific fact (a product, a price, a spec) is not explicitly in the KNOWLEDGE BASE provided, say so and stop — do not guess or estimate. A wrong product detail costs a sale. No answer is always safer than a wrong one.

When a BDS-specific fact isn't available, say one of:
- "I don't have that spec on file — check with Idris, Kaviya, or Areefa."
- "I don't have pricing for that — confirm with Idris, Kaviya, or Areefa before quoting."
- "That's not something I have details on — check with Idris, Kaviya, or Areefa before quoting the client."

## Response rules
- Be brief. Most answers: 3–5 bullet points or 2–3 sentences. No waffle.
- Lead with the answer. Never open with "Great question!" or any filler.
- Emails: write the full email only — no commentary before or after.
- Products: name, price, URL, one-line reason. Max 3 options. Exception: for fabric spec or GSM questions, just list the fabric name and GSM value — no price or URL needed.
- FABRIC GSM: In the product catalog, "Material: [number]" entries (e.g. "Material: 100", "Material: 300") are Shopify price-tier SKU variants — NOT fabric weights in GSM. Real GSM values are written explicitly as "(X GSM)" in the product name itself. Never interpret "Material: 100" as "100 GSM".
- URL variants: when the same product appears with numbered URL suffixes (-2, -3, -4), these are price-tier variants of ONE product — consolidate into a single listing with the main URL.
- Product name matching: if you find a close match to what the rep typed, present it confidently. Only say "Check Shopify admin" if you genuinely have nothing close.
- Discounts: never volunteer a discount code or suggest a lower price unless the client explicitly asks. Use the DISCOUNTS section only — never invent codes.
- Order history: use ORDER HISTORY (SHOPIFY) as the authoritative source. If it's not present, say "I don't have that order on file — check Shopify directly."
- NEVER list what data you do or don't have loaded. If something is unknown, say so in one sentence and move on.
- NEVER describe your own context, session state, or knowledge sources.

## Company
- HQ: Dallas TX | India office: Coimbatore
- US warehouses: Grand Prairie TX, Irvine CA | AU: Brisbane | UK: High Peak, Derbyshire
- backdropsource.com | backdropsource.co.uk | +1 (650) 614-1888
- This is an internal tool for the sales team — never direct reps to email sales@backdropsource.com or suggest they contact "the team" generically. When in doubt, name the person: Idris, Kaviya, or Areefa.
- Markets: US (USD), Canada (CAD), UK (GBP), AU (AUD), NZ (NZD), UAE (AED), India (INR), EU (EUR)
- Always use the correct currency for the client's market.

## Tone by market
- US/AU/NZ: warm, direct | UK: restrained-warm, first names, answer-first | UAE/DE/FR: formal

## Sales playbooks
The playbooks apply to ALL markets — US, UK, AU, NZ, CA, UAE. They are built from 1,368 real email threads and cover the right approach for complaints, objections, quotes, mockups, follow-ups, and new inquiries. The process is universal. What changes per market:
- **Currency:** USD for US/CA, GBP for UK, AUD for AU, NZD for NZ, AED for UAE
- **VAT:** applies to UK orders; not applicable for US/AU/NZ/CA
- **Tone:** US/AU/NZ = warm and direct; UK = restrained-warm, first names; UAE = formal
Everything else — the complaint sequence, objection handling, follow-up timing, quote structure — follows the same playbook regardless of market.

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

## Escalate to Idris, Kaviya, or Areefa
Custom pricing, discounts over 10%, order exceptions, complaints over £1,000 or involving safety issues, clients threatening chargebacks or legal action. Always name one of them specifically — never say "escalate to management" or "contact the team".`;

// ─── Model Selection ──────────────────────────────────────────────────────
// Sonnet: anything requiring tone, nuance, or complex reasoning
// Haiku:  fast factual lookups — order history, product info, geo queries
//
// Rule of thumb: if the rep is going to send this output directly to a client
// → Sonnet. If they're just looking something up → Haiku.

const MODELS: Record<string, string> = {
  groq:      'llama-3.1-8b-instant',
  deepseek:  'deepseek-chat',
  anthropic: 'claude-sonnet-4-6',
};

// Maps a model ID to which provider client to use.
type Provider = 'groq' | 'deepseek' | 'anthropic';
const MODEL_TO_PROVIDER: Record<string, Provider> = {
  'deepseek-chat':              'deepseek',
  'llama-3.1-8b-instant':       'groq',
  'llama-3.3-70b-versatile':    'groq',
  'claude-sonnet-4-6':          'anthropic',
  'claude-haiku-4-5-20251001':  'anthropic',
};

function selectModel(): string {
  return MODELS[LLM_PROVIDER] ?? MODELS.groq;
}

// ─── API Route Handler ────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const { messages, category, geo, model: requestedModel } = await req.json();

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response('Invalid request: messages array required', { status: 400 });
    }

    const orderContext = lookupOrders(messages as Message[]);
    // Per-request model override (from UI selector) takes precedence over env var default.
    const model = (requestedModel && MODEL_TO_PROVIDER[requestedModel]) ? requestedModel : selectModel();

    // ── System prompt: Milvus RAG if configured, else file-based routing ──
    const useMilvus = !!(process.env.MILVUS_ADDRESS && process.env.MILVUS_TOKEN && process.env.OPENAI_API_KEY);
    let systemPrompt: string;

    if (useMilvus) {
      // Build a rich query from the last 4 messages for semantic retrieval
      const recentQuery = (messages as Message[])
        .slice(-4)
        .map((m) => m.content)
        .join(' ');
      // Run knowledge + transcript retrieval in parallel
      const transcriptQuery = /call|transcript|example|how did|what did|rep said|client said|objection|handled|past call|previous call|real call|common|clients raise|on calls|in practice|real world|what do clients|how do reps|training|coaching/.test(recentQuery.toLowerCase());
      const [knowledgeContext, transcriptContext] = await Promise.all([
        retrieveKnowledge(recentQuery, category, 10),
        transcriptQuery ? retrieveTranscripts(recentQuery) : Promise.resolve(''),
      ]);

      if (knowledgeContext) {
        // Milvus returned results — use RAG path
        systemPrompt = buildSystemPromptMilvus(knowledgeContext, orderContext, transcriptContext);
        console.log(`[BDS Copilot] Mode: Milvus RAG | category=${category ?? 'none'}`);
      } else {
        // Milvus configured but returned nothing (not indexed yet, or cold cluster)
        // Fall back to file-based routing so the agent always has knowledge
        const selectedFiles = detectFilesToLoad(messages as Message[], category, geo);
        systemPrompt = buildSystemPrompt(selectedFiles, orderContext);
        console.warn(`[BDS Copilot] Milvus returned empty — fell back to file routing | category=${category ?? 'none'}`);
      }
    } else {
      // Fallback: keyword-based file routing (works without Milvus configured)
      const selectedFiles = detectFilesToLoad(messages as Message[], category, geo);
      systemPrompt = buildSystemPrompt(selectedFiles, orderContext);
      console.log(`[BDS Copilot] Mode: file routing | category=${category ?? 'none'}`);
    }

    const llmMessages = [
      { role: 'system' as const, content: systemPrompt },
      // Cap history at last 6 messages (3 exchanges) — stale wrong answers
      // from localStorage history poison the context and reinforce bad behaviour.
      ...(messages as Message[]).slice(-6).map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ];

    const provider: Provider = MODEL_TO_PROVIDER[model] ?? (LLM_PROVIDER as Provider);
    console.log(`[BDS Copilot] LLM: ${model} (${provider})`);

    const readableStream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        try {
          let inputTokens = 0;
          let outputTokens = 0;

          if (provider === 'anthropic') {
            // Anthropic Messages API — system prompt is a separate param, not in messages[]
            const systemMsg = llmMessages[0].content;
            const convMessages = llmMessages.slice(1).map(m => ({
              role: m.role as 'user' | 'assistant',
              content: m.content,
            }));

            const stream = anthropic.messages.stream({
              model,
              max_tokens: 1024,
              system: systemMsg,
              messages: convMessages,
            });

            for await (const event of stream) {
              if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                controller.enqueue(enc.encode(event.delta.text));
              }
              if (event.type === 'message_start') {
                inputTokens = event.message.usage.input_tokens;
              }
              if (event.type === 'message_delta' && 'usage' in event) {
                outputTokens = (event as { usage?: { output_tokens?: number } }).usage?.output_tokens ?? 0;
              }
            }
          } else {
            // OpenAI-compatible path: Groq and DeepSeek
            const client = provider === 'deepseek' ? deepseek : groq;
            const stream = await (client as OpenAI).chat.completions.create({
              model,
              max_tokens: 800,
              messages: llmMessages,
              stream: true,
            });

            for await (const chunk of stream) {
              const delta = chunk.choices[0]?.delta?.content;
              if (delta) controller.enqueue(enc.encode(delta));

              // Usage comes in the final chunk (Groq stores it in x_groq, DeepSeek in chunk.usage)
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const usage = (chunk as any).x_groq?.usage ?? chunk.usage;
              if (usage) {
                inputTokens  = usage.prompt_tokens     ?? 0;
                outputTokens = usage.completion_tokens ?? 0;
              }
            }
          }

          // Append token usage as a hidden sentinel the frontend parses out
          controller.enqueue(enc.encode(`\n\n__USAGE__${JSON.stringify({ input: inputTokens, output: outputTokens, model })}__END__`));
          controller.close();
        } catch (streamErr) {
          console.error('[BDS Copilot] Stream error:', streamErr);
          const msg = streamErr instanceof Error ? streamErr.message : 'Unknown stream error';
          controller.enqueue(enc.encode(`⚠️ Error: ${msg}. Please try again.`));
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
