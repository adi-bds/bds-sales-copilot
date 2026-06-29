# BDS Sales Copilot

AI-powered sales assistant for Backdropsource reps. Built on Next.js, with multi-model LLM support and a fully local RAG system (no external vector database required).

---

## What it does

A chat interface reps use daily to:
- Get instant product specs, sizing, fabric details, and frame types
- Draft complaint, quote, and follow-up emails using real playbooks
- Look up customer order history by name / email / order number
- Prep for calls with B2B client intelligence
- Switch between AI models depending on speed/quality needs

---

## Architecture

```
Browser (page.tsx)
    ↓ POST /api/chat  (includes selected model)
app/api/chat/route.ts
    ↓ embed last 4 messages via OpenAI text-embedding-3-small
lib/localEmbeddings.ts  ← cosine similarity over knowledge/embeddings.json
    ↓ top 5 most relevant knowledge chunks
LLM API (Anthropic / Groq / DeepSeek) — streaming
    ↓ Server-Sent Events
Browser renders response
```

**RAG is fully local** — embeddings live in `knowledge/embeddings.json` (generated once, not committed to git). No external vector DB needed at runtime. Only OpenAI is called to embed each incoming query (~0.01¢/query).

---

## Prerequisites

Before you start, make sure you have:

| Tool | Version | Install |
|---|---|---|
| **Node.js** | 20+ | [nodejs.org](https://nodejs.org) — download the LTS version |
| **npm** | comes with Node | (no separate install needed) |
| **Git** | any recent | [git-scm.com](https://git-scm.com) |

To check if you already have them:
```bash
node --version    # should say v20.x or higher
npm --version     # should say 10.x or higher
git --version
```

---

## API keys you need

Sign up / log in to each service and get an API key:

| Service | What it's for | Where to get the key |
|---|---|---|
| **OpenAI** | Embedding queries (text-embedding-3-small) | [platform.openai.com](https://platform.openai.com) → API keys |
| **Groq** | Llama 3.3 70B and Llama 3.1 8B models (fast, free tier available) | [console.groq.com](https://console.groq.com) → API keys |
| **Anthropic** | Claude Sonnet + Claude Haiku models | [console.anthropic.com](https://console.anthropic.com) → API keys |
| **DeepSeek** *(optional)* | DeepSeek V3 model | [platform.deepseek.com](https://platform.deepseek.com) → API keys |

You need OpenAI plus at least one LLM provider. Groq is the easiest to start with — it has a generous free tier.

---

## Setup (step by step)

### 1. Clone the repo

```bash
git clone https://github.com/adi-bds/bds-sales-copilot.git
cd bds-sales-copilot/bds-sales-copilot
```

### 2. Install dependencies

```bash
npm install
```

This installs everything: Next.js, the Anthropic SDK, Groq SDK, OpenAI SDK, and all other packages listed in `package.json`.

### 3. Create your `.env.local` file

Create a file called `.env.local` in the project root (same folder as `package.json`). This file is gitignored and never committed — you create it fresh on each machine.

```bash
# --- Required ---

# OpenAI — used only for embedding queries at runtime (not for chat)
OPENAI_API_KEY=sk-...

# Groq — for Llama 3.3 70B and Llama 3.1 8B
GROQ_API_KEY=gsk_...

# Anthropic — for Claude Sonnet and Claude Haiku
ANTHROPIC_API_KEY=sk-ant-...

# Must be true to use the local embeddings system
USE_BUNDLED_EMBEDDINGS=true

# Default LLM provider when no model is selected in the UI
# Options: groq | anthropic | deepseek
LLM_PROVIDER=groq

# --- Optional ---

# DeepSeek — for DeepSeek V3 model (leave blank or remove if not using)
DEEPSEEK_API_KEY=
```

### 4. Build the knowledge embeddings

The knowledge base lives in `knowledge/` as markdown files. Before the app can do semantic search, you need to generate an embeddings file. This calls OpenAI's embedding API once and saves the result locally.

```bash
npx tsx scripts/build_embeddings.ts
```

This takes 2–5 minutes and produces `knowledge/embeddings.json` (~200MB). You only need to run this:
- Once on a fresh setup
- Again any time you edit or add knowledge files

### 5. Start the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The copilot should be up and running.

---

## Deploying to Vercel

The app auto-deploys on every `git push` to `main`.

**First-time Vercel setup:**
1. Go to [vercel.com](https://vercel.com) and import the GitHub repo (`adi-bds/bds-sales-copilot`)
2. Go to Project Settings → Environment Variables and add all the same keys from your `.env.local`
3. Make sure `USE_BUNDLED_EMBEDDINGS=true` and `LLM_PROVIDER=groq` are included

**Note on `embeddings.json` and Vercel:**
`embeddings.json` is gitignored (too large for GitHub at ~200MB). For production, you would need to either:
- Upload `embeddings.json` to S3/Cloudflare R2 and fetch it at cold start *(not yet set up)*
- Or switch back to Milvus/Zilliz as the vector DB *(original architecture — all the code is still there in `lib/milvus.ts`)*

For now, this is set up for local development. Production deployment needs a solution for this — check with Adi.

---

## Available AI models

| Model | Provider | Best for |
|---|---|---|
| Claude Sonnet | Anthropic | Complex reasoning, nuanced emails |
| Claude Haiku | Anthropic | Quick lookups, short answers |
| DeepSeek V3 | DeepSeek | General use |
| Llama 3.3 70B | Groq | Good balance of speed and quality |
| Llama 3.1 8B | Groq | Fastest responses, very low cost |

Switch models using the dropdown in the sidebar. Selection persists for the session.

---

## Knowledge base — how to update

All knowledge lives in `knowledge/` as plain markdown files. Edit them directly in any text editor.

```
knowledge/
├── core/
│   ├── frames_and_finishes.md      — frame types, finish specs, GSM table, kit configs
│   ├── rep_workflow.md             — delivery timelines, artwork specs, payment methods
│   ├── customization_rules.md      — sizing rules, what BDS can/can't do
│   ├── call_insights.md            — patterns from call transcripts
│   ├── order_patterns.md           — geo-specific sales intelligence
│   ├── discounts.md                — discount codes and escalation rules
│   └── b2b_customers.md            — top B2B customers for call prep
├── products/
│   ├── products_toc.md             — product category overview
│   ├── products_booth_kits.md
│   ├── products_media_walls_backdrops.md
│   ├── products_banners_printing.md
│   ├── products_counters_displays.md
│   ├── products_photo_studio.md
│   ├── products_outdoor_events.md
│   └── products_other.md
└── uk/
    ├── uk_complaints_playbook.md
    ├── uk_objection_playbook.md
    ├── uk_quote_playbook.md
    ├── uk_followup_reorder_playbook.md
    ├── uk_initial_inquiry_playbook.md
    └── uk_mockup_design_playbook.md
```

**After editing any knowledge file, always rebuild embeddings:**

```bash
npx tsx scripts/build_embeddings.ts
```

The `embeddings.json` output stays local (gitignored) — no need to commit it.

---

## Common tasks

**Update a product price or spec:**
Edit the relevant `knowledge/products/products_<category>.md` → rebuild embeddings → push.

**Add a new playbook:**
Create a `.md` file in `knowledge/uk/` or `knowledge/core/` → rebuild embeddings → push.

**Change the agent's personality or rules:**
Edit `CORE_INSTRUCTIONS` in `app/api/chat/route.ts` → push. No embeddings rebuild needed.

**Copilot gives a wrong answer:**
Find the relevant knowledge file → fix the fact → rebuild embeddings → push.

**Add a new AI model:**
1. Add the model ID and provider to `MODEL_TO_PROVIDER` in `app/api/chat/route.ts`
2. Add it to `AVAILABLE_MODELS` in `app/page.tsx`
3. Add the provider's API key to `.env.local`

---

## Code map

| File | Purpose |
|---|---|
| `app/page.tsx` | Chat UI — model selector, nav, geo selector, streaming, cost display |
| `app/api/chat/route.ts` | Main API — retrieval routing, system prompt, multi-model streaming |
| `lib/localEmbeddings.ts` | RAG engine — cosine similarity search over embeddings.json |
| `lib/milvus.ts` | Legacy Zilliz/Milvus retrieval (still works if you want to switch back) |
| `scripts/build_embeddings.ts` | Generates knowledge/embeddings.json from all markdown files |
| `scripts/summarize_transcripts.ts` | Summarizes call recordings into knowledge chunks using Groq |
| `next.config.ts` | Bundles knowledge/ files into the serverless function |
| `vercel.json` | Vercel cron config |

---

## Approximate cost per query

| Component | Cost |
|---|---|
| Query embedding (OpenAI) | ~$0.000002 |
| Claude Sonnet (~1K output tokens) | ~$0.005 |
| Claude Haiku (~1K output tokens) | ~$0.0005 |
| Llama 3.3 70B via Groq | ~$0.001 |
| Llama 3.1 8B via Groq | ~$0.0001 |

---

## Troubleshooting

**"embeddings.json not found" on startup**
Run `npx tsx scripts/build_embeddings.ts` — the file needs to be generated locally first.

**Model not responding / "not-configured" error**
The API key for that model's provider is missing from `.env.local`. Add it and restart the dev server.

**Copilot doesn't know about something I just added to the knowledge base**
You edited a markdown file but didn't rebuild embeddings. Run `npx tsx scripts/build_embeddings.ts`.

**`npm install` fails**
Make sure you're on Node.js 20+. Run `node --version` to check, then download the LTS version from nodejs.org if needed.

**Port 3000 already in use**
Another process is using port 3000. Either stop it, or run `npm run dev -- -p 3001` to use a different port.
