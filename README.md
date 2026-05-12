# BDS Sales Copilot — Handoff Guide

AI-powered sales assistant for Backdropsource reps. Built on Next.js 16, Anthropic Claude, Zilliz vector search, and Vercel.

---

## What it does

A chat interface reps use daily to:
- Get instant product specs, sizing, and pricing
- Draft complaint and quote emails using real playbooks
- Look up customer order history by name/email/order number
- Prep for calls with B2B client intelligence
- Handle UK-specific queries with a separate geo selector

---

## Architecture overview

```
Browser (page.tsx)
    ↓ POST /api/chat
app/api/chat/route.ts
    ↓ embed last 4 messages
Zilliz (cloud.zilliz.com) — bds_knowledge collection
    ↓ top 5 most similar chunks
Claude claude-sonnet-4-6 (streaming)
    ↓ Server-Sent Events
Browser renders response
```

**Two retrieval modes:**
- **Milvus RAG** (primary): semantic search over 1,000+ knowledge chunks → cheapest, ~$0.015/query
- **File fallback** (backup when Milvus is cold/empty): keyword-based file loading → ~$0.035/query

---

## Accounts & services you need access to

| Service | What it's for | Where to find credentials |
|---|---|---|
| **Vercel** | Hosts the app | vercel.com — project: bds-sales-copilot |
| **Anthropic** | Claude API (chat) | console.anthropic.com |
| **OpenAI** | Embeddings only (text-embedding-3-small) | platform.openai.com |
| **Zilliz Cloud** | Vector database for knowledge search | cloud.zilliz.com |
| **GitHub** | Source code | github.com — repo: adidevas/bds-sales-copilot |

---

## Environment variables

Create `.env.local` in the project root (never commit this file — it's gitignored):

```bash
# Anthropic — get from console.anthropic.com → API keys
ANTHROPIC_API_KEY=sk-ant-...

# Zilliz — get from cloud.zilliz.com → your cluster → Connect → REST API
MILVUS_ADDRESS=https://in03-xxxx.serverless.aws-eu-central-1.cloud.zilliz.com
MILVUS_TOKEN=your_api_key_here

# OpenAI — get from platform.openai.com → API keys
OPENAI_API_KEY=sk-...
```

These same four keys must also be set in **Vercel → Project Settings → Environment Variables**.

---

## Local development

```bash
# 1. Clone
git clone https://github.com/adidevas/bds-sales-copilot
cd bds-sales-copilot/bds-sales-copilot

# 2. Install dependencies
npm install

# 3. Create .env.local with the four keys above

# 4. Run dev server
npm run dev
# → http://localhost:3000
```

---

## Deploying to production

The app auto-deploys on every `git push` to `main` via Vercel.

```bash
git add .
git commit -m "your change"
git push
```

Vercel picks it up in ~60 seconds. No manual deploy step needed.

---

## Knowledge base — how to update

### Product catalog (most common update)

When Shopify prices/variants change, rebuild the product files from a fresh CSV export:

```bash
# Export orders from Shopify → paste CSV path below
python3 scripts/rebuild_products.py /path/to/shopify_export.csv
```

This rewrites all 8 product markdown files in `knowledge/products/`.

After updating any knowledge file, **re-run the indexer** (see below).

### Knowledge files location

```
knowledge/
├── core/
│   ├── sales_playbook.md       — pricing tiers, tone rules, core workflow
│   ├── rep_workflow.md         — delivery timelines, artwork specs, payment methods
│   ├── customization_rules.md  — print specs, DPI, pole pockets, fabric types
│   ├── call_insights.md        — patterns mined from 9,321 call transcripts
│   ├── order_patterns.md       — geo-specific sales intelligence from 12,561 orders
│   ├── discounts.md            — discount codes and escalation rules
│   ├── b2b_customers.md        — top 200 B2B customers for call prep
│   └── blog_posts.md           — pitch angles and selling points
├── products/
│   ├── products_toc.md         — product category overview (always loaded)
│   ├── products_booth_kits.md
│   ├── products_media_walls_backdrops.md
│   ├── products_banners_printing.md
│   ├── products_counters_displays.md
│   ├── products_photo_studio.md
│   ├── products_outdoor_events.md
│   ├── products_other.md
│   └── products_fifa_2026.md
├── uk/
│   ├── uk_complaints_playbook.md
│   ├── uk_objection_playbook.md
│   ├── uk_quote_playbook.md
│   ├── uk_followup_reorder_playbook.md
│   ├── uk_initial_inquiry_playbook.md
│   └── uk_mockup_design_playbook.md
└── orders/
    └── orders_index.json       — 17,000+ Shopify orders indexed by order#/email/name
```

Just edit the relevant `.md` file, then re-index.

---

## Zilliz indexer — IMPORTANT

The Zilliz collection must be re-indexed every time knowledge files change. This embeds all chunks and uploads them to Zilliz.

```bash
# Run from the project root
npx ts-node --project tsconfig.scripts.json scripts/index_knowledge.ts
```

**If it fails with "duplicate collection" error:**
1. Go to cloud.zilliz.com → your cluster → Collections
2. Delete the `bds_knowledge` collection manually
3. Re-run the indexer

The indexer takes ~3–5 minutes to embed 1,000+ chunks.

### Transcript indexer (optional)

If you have new call recordings to add to the RAG corpus:

```bash
npx ts-node --project tsconfig.scripts.json scripts/index_transcripts.ts
```

---

## Orders index — updating

When new Shopify orders come in, regenerate the orders index:

```bash
# (script location — ask Adi for the orders CSV export process)
# The index lives at knowledge/orders/orders_index.json
# It's indexed by order number (US#16111), email, and customer name
```

---

## Vercel keepalive cron

`vercel.json` has a cron job that pings `/api/ping` every 5 minutes to keep the Zilliz free-tier cluster awake. If the cluster goes to sleep, the first query falls back to file-based routing (still works, slightly higher cost).

---

## Cost per query

| Mode | Input tokens | Cost |
|---|---|---|
| Milvus RAG (normal) | ~5K | ~$0.015 |
| File fallback (cold Milvus) | ~12K | ~$0.035 |
| Old behaviour (before cost fix) | ~126K | ~$0.38 |

---

## Code map — what does what

| File | Purpose |
|---|---|
| `app/page.tsx` | Full chat UI — nav, geo selector, streaming, feedback buttons |
| `app/api/chat/route.ts` | Main API handler — retrieval routing, system prompt, Claude streaming |
| `app/api/ping/route.ts` | Zilliz keepalive — called by Vercel cron every 5 min |
| `lib/zilliz.ts` | Zilliz REST client — search, insert, collection management |
| `lib/milvus.ts` | Knowledge retrieval — embed query, search, return top chunks |
| `scripts/index_knowledge.ts` | Re-index knowledge base into Zilliz |
| `scripts/index_transcripts.ts` | Index call transcripts into Zilliz |
| `scripts/rebuild_products.py` | Rebuild product .md files from Shopify CSV |
| `next.config.ts` | Bundles knowledge/ files into Vercel serverless function |
| `vercel.json` | Cron job config for keepalive |

---

## Claude Cowork skill (for Adi's machine)

There's a Claude skill at `~/.claude/skills/bds-sales-copilot/` on Adi's machine. This is separate from the deployed app — it lets Adi (or you) ask Claude directly about BDS products and sales without opening the web app. To use it on your machine:

1. Install Claude desktop app + Cowork
2. Copy the `bds-sales-copilot/` folder to `~/.claude/skills/` on your machine
3. The skill auto-triggers when you ask BDS-related questions in Cowork

---

## Common tasks

**Update a product price:**
Edit `knowledge/products/products_<category>.md` directly → re-run indexer → push.

**Add a new UK playbook:**
Create `knowledge/uk/uk_newplaybook.md` → add filename to `PLAYBOOK_FILES` array in `app/api/chat/route.ts` → re-run indexer → push.

**Agent gives wrong answer:**
Check the relevant knowledge file — the answer is probably outdated there. Edit the .md file, re-index, push.

**Zilliz cluster is asleep (first query is slow):**
The cron keepalive should prevent this. If it happens, the first query falls back to file routing (still works). Second query onwards uses Milvus.

**Change the agent's personality/rules:**
Edit `CORE_INSTRUCTIONS` in `app/api/chat/route.ts` → push. No re-indexing needed.

---

## Git history

The full build history is in git. Key commits:
- `fa7359c` — Milvus fallback to file routing when empty
- `5f4efc0` — Cost reduction: chunking + file fallback overhaul
- `3a6f458` — Session-only chats (no localStorage persistence)
- `3a00c9a` — Switched to Zilliz REST (gRPC doesn't work on serverless)
- `07bf770` — call_insights.md from 9,321 transcripts
- `876168b` — Wall-Hanging Backdrop size variants fix + rebuild_products.py
