/**
 * BDS Copilot — Query Pricing Test Runner
 *
 * Sends test queries to the local dev server (or any URL) and records
 * token counts + cost per query type. Outputs a table to the terminal
 * and saves results as CSV + HTML chart to scripts/pricing_results/.
 *
 * Usage:
 *   # Start dev server first: npm run dev
 *   npx ts-node --project tsconfig.scripts.json scripts/test_pricing.ts
 *
 *   # Against production:
 *   BASE_URL=https://your-app.vercel.app npx ts-node --project tsconfig.scripts.json scripts/test_pricing.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const PRICE_INPUT  = 3.00;   // $ per million input tokens (Sonnet)
const PRICE_OUTPUT = 15.00;  // $ per million output tokens (Sonnet)

// ── Test cases ─────────────────────────────────────────────────────────────────

interface TestCase {
  category_label: string;   // human-readable category for the chart
  api_category:   string | null;  // value sent as `category` in the API call
  api_geo:        string | null;
  prompt:         string;
}

const TEST_CASES: TestCase[] = [

  // ── PRODUCT — common ───────────────────────────────────────────────────────
  {
    category_label: 'Product — common (10x10 booth)',
    api_category: 'product',
    api_geo: null,
    prompt: 'What 10x10 booth kits do you have and what are the prices?',
  },
  {
    category_label: 'Product — common (media wall)',
    api_category: 'product',
    api_geo: null,
    prompt: 'Client wants a tension fabric media wall for a trade show. What sizes and prices do we have?',
  },
  {
    category_label: 'Product — size variants',
    api_category: 'product',
    api_geo: null,
    prompt: 'What are the size variants for the Custom Wall-Hanging Backdrop with Clamps?',
  },

  // ── PRODUCT — niche ────────────────────────────────────────────────────────
  {
    category_label: 'Product — niche (sky tube)',
    api_category: 'product',
    api_geo: null,
    prompt: 'Client wants a circular hanging banner from the ceiling for a trade show, seen it called a sky tube. Pricing?',
  },
  {
    category_label: 'Product — niche (inflatable tube man)',
    api_category: 'product',
    api_geo: null,
    prompt: 'Client running a car dealership wants one of those inflatable dancing tube men out front. Do we sell those?',
  },
  {
    category_label: 'Product — niche (meeting pod)',
    api_category: 'product',
    api_geo: null,
    prompt: 'Client wants a semi-private branded meeting area inside their trade show booth — like an enclosed pod. What do we have?',
  },
  {
    category_label: 'Product — niche (truss tower)',
    api_category: 'product',
    api_geo: null,
    prompt: 'Client wants a tall freestanding branded tower printed on all 4 sides — a column in the middle of the floor. What is our option for that?',
  },

  // ── EMAIL / COMPLAINT ──────────────────────────────────────────────────────
  {
    category_label: 'Email — complaint (first contact)',
    api_category: 'email',
    api_geo: null,
    prompt: 'Client received their order and the fabric has a colour mismatch — it looks washed out vs what they approved on the mockup. Draft the first reply.',
  },
  {
    category_label: 'Email — complaint (missing item)',
    api_category: 'email',
    api_geo: null,
    prompt: 'Client says they ordered a booth kit but the carry case didn\'t arrive — only the frame and graphics showed up. First email response.',
  },
  {
    category_label: 'Email — quote follow-up',
    api_category: 'email',
    api_geo: null,
    prompt: 'I sent a quote to Sarah at ABC Events 5 days ago for a 10x10 booth kit at $1,450. No response. Write a follow-up email.',
  },
  {
    category_label: 'Email — UK complaint',
    api_category: 'email',
    api_geo: 'uk',
    prompt: 'UK client says their banner arrived damaged — the graphic is torn on one side. Draft the first response.',
  },

  // ── CALL PREP ──────────────────────────────────────────────────────────────
  {
    category_label: 'Call prep — B2B client',
    api_category: 'callprep',
    api_geo: null,
    prompt: 'I have a call with Global Vision Events in 20 minutes. What do we know about them and what should I lead with?',
  },
  {
    category_label: 'Call prep — objection handling',
    api_category: 'callprep',
    api_geo: null,
    prompt: 'Client on the phone says they found the same product cheaper on another site. How do I handle this?',
  },

  // ── TRAINING ───────────────────────────────────────────────────────────────
  {
    category_label: 'Training — new rep product overview',
    api_category: 'training',
    api_geo: null,
    prompt: 'I\'m a new rep. Walk me through the main product categories we sell and when to recommend each one.',
  },
  {
    category_label: 'Training — delivery timeline',
    api_category: 'training',
    api_geo: null,
    prompt: 'What do I tell clients when they ask how long delivery takes? What are all the options?',
  },

  // ── GENERAL QUESTIONS ─────────────────────────────────────────────────────
  {
    category_label: 'General — rush order',
    api_category: null,
    api_geo: null,
    prompt: 'Client needs a backdrop for an event this Friday. Today is Monday. Is that possible and what are my options?',
  },
  {
    category_label: 'General — replacement fabric',
    api_category: null,
    api_geo: null,
    prompt: 'Client already has a frame from another supplier and just wants a replacement fabric from us. How do I quote this?',
  },
  {
    category_label: 'General — outdoor use question',
    api_category: null,
    api_geo: null,
    prompt: 'Client wants to use a fabric backdrop outdoors at a street event. Can we guarantee it won\'t get damaged in light rain?',
  },
  {
    category_label: 'General — pole pockets',
    api_category: null,
    api_geo: null,
    prompt: 'Client wants pole pockets on all four sides of a banner with envelope corners for pipe and drape. Can we do that?',
  },

  // ── UK SPECIFIC ────────────────────────────────────────────────────────────
  {
    category_label: 'UK — pricing question',
    api_category: null,
    api_geo: 'uk',
    prompt: 'UK client asking about pricing for a 3m x 2.3m tension fabric display. What do we charge and what\'s included?',
  },

  // ── ORDER LOOKUP ───────────────────────────────────────────────────────────
  {
    category_label: 'Order lookup — by order number',
    api_category: null,
    api_geo: null,
    prompt: 'Can you pull up order US#16111 for me?',
  },
  {
    category_label: 'Order lookup — by name',
    api_category: null,
    api_geo: null,
    prompt: 'What has Jennifer Smith ordered with us before?',
  },
];

// ── API call ───────────────────────────────────────────────────────────────────

interface UsageResult {
  input:  number;
  output: number;
  model:  string;
}

async function queryAPI(tc: TestCase): Promise<{ usage: UsageResult; response: string; durationMs: number }> {
  const body = {
    messages: [{ role: 'user', content: tc.prompt }],
    category: tc.api_category,
    geo: tc.api_geo,
  };

  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let raw = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }

  const durationMs = Date.now() - t0;

  // Parse __USAGE__{}__END__ block appended by the API
  const usageMatch = raw.match(/__USAGE__([\s\S]+?)__END__/);
  if (!usageMatch) throw new Error('No usage block in response');

  const usage: UsageResult = JSON.parse(usageMatch[1]);
  const response = raw.replace(/__USAGE__[\s\S]+?__END__/, '').trim();

  return { usage, response, durationMs };
}

// ── Formatting helpers ─────────────────────────────────────────────────────────

function calcCost(u: UsageResult): number {
  return (u.input / 1_000_000) * PRICE_INPUT + (u.output / 1_000_000) * PRICE_OUTPUT;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function rpad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : ' '.repeat(n - s.length) + s;
}

// ── CSV output ─────────────────────────────────────────────────────────────────

interface Row {
  category_label: string;
  prompt:         string;
  input_tokens:   number;
  output_tokens:  number;
  total_tokens:   number;
  cost_usd:       number;
  duration_ms:    number;
  model:          string;
  error?:         string;
}

function saveCSV(rows: Row[], outPath: string) {
  const headers = ['category','prompt','input_tokens','output_tokens','total_tokens','cost_usd','duration_ms','model','error'];
  const lines = [headers.join(',')];
  for (const r of rows) {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    lines.push([
      esc(r.category_label), esc(r.prompt),
      r.input_tokens, r.output_tokens, r.total_tokens,
      r.cost_usd.toFixed(5), r.duration_ms, esc(r.model), esc(r.error ?? ''),
    ].join(','));
  }
  fs.writeFileSync(outPath, lines.join('\n'));
}

// ── HTML chart output ─────────────────────────────────────────────────────────

function saveHTML(rows: Row[], outPath: string) {
  const successRows = rows.filter(r => !r.error);
  const maxTokens = Math.max(...successRows.map(r => r.input_tokens), 1);
  const maxCost   = Math.max(...successRows.map(r => r.cost_usd), 0.001);

  const barRows = successRows.map(r => {
    const inputPct  = (r.input_tokens  / maxTokens * 100).toFixed(1);
    const totalPct  = (r.total_tokens  / maxTokens * 100).toFixed(1);
    const costPct   = (r.cost_usd      / maxCost   * 100).toFixed(1);
    const costColor = r.cost_usd < 0.02 ? '#1a6b3c' : r.cost_usd < 0.05 ? '#b85c00' : '#c0392b';
    return `
      <tr>
        <td class="label">${r.category_label}</td>
        <td class="bar-cell">
          <div class="bar-bg">
            <div class="bar-fill input" style="width:${inputPct}%"></div>
            <div class="bar-fill output" style="width:${totalPct}%; left:${inputPct}%"></div>
          </div>
          <span class="bar-num">${r.input_tokens.toLocaleString()} in / ${r.output_tokens} out</span>
        </td>
        <td class="cost" style="color:${costColor}">$${r.cost_usd.toFixed(4)}</td>
        <td class="dur">${(r.duration_ms / 1000).toFixed(1)}s</td>
      </tr>`;
  }).join('');

  // Group by category prefix for summary
  type Group = { label: string; rows: Row[]; avgCost: number; avgInput: number };
  const groups = new Map<string, Group>();
  for (const r of successRows) {
    const prefix = r.category_label.split(' — ')[0].trim();
    if (!groups.has(prefix)) groups.set(prefix, { label: prefix, rows: [], avgCost: 0, avgInput: 0 });
    groups.get(prefix)!.rows.push(r);
  }
  for (const g of groups.values()) {
    g.avgCost  = g.rows.reduce((s, r) => s + r.cost_usd,      0) / g.rows.length;
    g.avgInput = g.rows.reduce((s, r) => s + r.input_tokens,  0) / g.rows.length;
  }

  const summaryRows = [...groups.values()].sort((a, b) => b.avgCost - a.avgCost).map(g => {
    const color = g.avgCost < 0.02 ? '#1a6b3c' : g.avgCost < 0.05 ? '#b85c00' : '#c0392b';
    const daily50 = (g.avgCost * 50).toFixed(2);
    return `<tr>
      <td>${g.label}</td>
      <td>${Math.round(g.avgInput).toLocaleString()}</td>
      <td style="color:${color};font-weight:600">$${g.avgCost.toFixed(4)}</td>
      <td>$${daily50}</td>
    </tr>`;
  }).join('');

  const totalAvgCost = successRows.reduce((s, r) => s + r.cost_usd, 0) / (successRows.length || 1);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>BDS Copilot — Query Pricing</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, Arial, sans-serif; background: #f0f4f8; color: #1a1a1a; padding: 32px; }
  h1 { font-size: 24px; color: #1b2a4a; margin-bottom: 4px; }
  .subtitle { color: #666; font-size: 14px; margin-bottom: 32px; }
  .card { background: #fff; border-radius: 10px; box-shadow: 0 1px 4px rgba(0,0,0,.1); padding: 24px; margin-bottom: 28px; }
  h2 { font-size: 16px; color: #2e5fa3; margin-bottom: 16px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: #1b2a4a; color: #fff; text-align: left; padding: 8px 12px; font-weight: 600; }
  td { padding: 8px 12px; border-bottom: 1px solid #eee; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  tr:nth-child(even) td { background: #f8fafc; }
  .label { width: 260px; font-size: 12px; color: #333; }
  .bar-cell { position: relative; }
  .bar-bg { height: 18px; background: #e8eef7; border-radius: 3px; position: relative; overflow: hidden; width: 100%; }
  .bar-fill { height: 100%; position: absolute; top: 0; border-radius: 3px; }
  .bar-fill.input  { background: #2e5fa3; }
  .bar-fill.output { background: #7fb3e8; left: 0; }
  .bar-num { font-size: 11px; color: #666; white-space: nowrap; margin-left: 6px; }
  .cost { font-weight: 600; font-size: 14px; white-space: nowrap; width: 80px; }
  .dur  { font-size: 12px; color: #888; width: 60px; }
  .legend { display: flex; gap: 20px; margin-bottom: 12px; font-size: 12px; color: #555; }
  .legend-dot { width: 12px; height: 12px; border-radius: 2px; display: inline-block; margin-right: 4px; vertical-align: middle; }
  .stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 0; }
  .stat { text-align: center; }
  .stat-val { font-size: 28px; font-weight: 700; color: #1b2a4a; }
  .stat-label { font-size: 12px; color: #888; margin-top: 4px; }
  .error-row td { color: #c0392b; font-style: italic; }
</style>
</head>
<body>
  <h1>BDS Sales Copilot — Query Pricing Report</h1>
  <p class="subtitle">Generated ${new Date().toLocaleString()} · ${BASE_URL} · Sonnet 4.6 ($3/MTok in, $15/MTok out)</p>

  <div class="card">
    <h2>Summary</h2>
    <div class="stat-grid">
      <div class="stat">
        <div class="stat-val">${successRows.length}/${rows.length}</div>
        <div class="stat-label">Queries succeeded</div>
      </div>
      <div class="stat">
        <div class="stat-val">$${totalAvgCost.toFixed(4)}</div>
        <div class="stat-label">Average cost per query</div>
      </div>
      <div class="stat">
        <div class="stat-val">$${(totalAvgCost * 50 * 30).toFixed(2)}</div>
        <div class="stat-label">Est. monthly (30 reps × 50 queries/day)</div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>Average Cost by Query Type</h2>
    <table>
      <thead><tr><th>Query Type</th><th>Avg Input Tokens</th><th>Avg Cost</th><th>Cost per 50 queries</th></tr></thead>
      <tbody>${summaryRows}</tbody>
    </table>
  </div>

  <div class="card">
    <h2>All Queries — Token Usage & Cost</h2>
    <div class="legend">
      <span><span class="legend-dot" style="background:#2e5fa3"></span>Input tokens</span>
      <span><span class="legend-dot" style="background:#7fb3e8"></span>Output tokens</span>
    </div>
    <table>
      <thead><tr><th style="width:260px">Query</th><th>Token Usage</th><th>Cost</th><th>Time</th></tr></thead>
      <tbody>${barRows}</tbody>
    </table>
    ${rows.filter(r => r.error).map(r => `
    <table style="margin-top:8px"><tbody>
      <tr class="error-row"><td class="label">${r.category_label}</td><td colspan="3">❌ ${r.error}</td></tr>
    </tbody></table>`).join('')}
  </div>
</body>
</html>`;

  fs.writeFileSync(outPath, html);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const outDir = path.join(__dirname, 'pricing_results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

  console.log(`\n🧪 BDS Copilot Query Pricing Test`);
  console.log(`   Target: ${BASE_URL}`);
  console.log(`   Queries: ${TEST_CASES.length}\n`);

  const rows: Row[] = [];
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < TEST_CASES.length; i++) {
    const tc = TEST_CASES[i];
    const prefix = `[${String(i + 1).padStart(2, '0')}/${TEST_CASES.length}]`;
    process.stdout.write(`${prefix} ${tc.category_label.padEnd(45, ' ')} `);

    try {
      const { usage, durationMs } = await queryAPI(tc);
      const cost = calcCost(usage);
      const row: Row = {
        category_label: tc.category_label,
        prompt:         tc.prompt,
        input_tokens:   usage.input,
        output_tokens:  usage.output,
        total_tokens:   usage.input + usage.output,
        cost_usd:       cost,
        duration_ms:    durationMs,
        model:          usage.model,
      };
      rows.push(row);
      passed++;

      const costColor = cost < 0.02 ? '\x1b[32m' : cost < 0.05 ? '\x1b[33m' : '\x1b[31m';
      console.log(`${rpad(usage.input.toLocaleString(), 7)} in  ${rpad(usage.output.toString(), 4)} out  ${costColor}$${cost.toFixed(4)}\x1b[0m  ${(durationMs/1000).toFixed(1)}s`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      rows.push({
        category_label: tc.category_label,
        prompt: tc.prompt,
        input_tokens: 0, output_tokens: 0, total_tokens: 0,
        cost_usd: 0, duration_ms: 0, model: '', error: msg,
      });
      failed++;
      console.log(`\x1b[31m❌ ${msg.slice(0, 60)}\x1b[0m`);
    }

    // Small delay between requests
    if (i < TEST_CASES.length - 1) await new Promise(r => setTimeout(r, 500));
  }

  // ── Summary table ────────────────────────────────────────────────────────
  const successRows = rows.filter(r => !r.error);
  const avgCost  = successRows.reduce((s, r) => s + r.cost_usd,     0) / (successRows.length || 1);
  const avgInput = successRows.reduce((s, r) => s + r.input_tokens, 0) / (successRows.length || 1);
  const maxCost  = Math.max(...successRows.map(r => r.cost_usd), 0);
  const minCost  = Math.min(...successRows.map(r => r.cost_usd), 999);

  console.log(`\n${'─'.repeat(72)}`);
  console.log(pad('Category', 45) + rpad('Avg Input', 12) + rpad('Avg Cost', 12));
  console.log('─'.repeat(72));

  const groups = new Map<string, Row[]>();
  for (const r of successRows) {
    const prefix = r.category_label.split(' — ')[0].trim();
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix)!.push(r);
  }
  for (const [label, gRows] of [...groups.entries()].sort((a, b) => {
    const avgA = a[1].reduce((s, r) => s + r.cost_usd, 0) / a[1].length;
    const avgB = b[1].reduce((s, r) => s + r.cost_usd, 0) / b[1].length;
    return avgB - avgA;
  })) {
    const ga = gRows.reduce((s, r) => s + r.input_tokens, 0) / gRows.length;
    const gc = gRows.reduce((s, r) => s + r.cost_usd,     0) / gRows.length;
    const cc = gc < 0.02 ? '\x1b[32m' : gc < 0.05 ? '\x1b[33m' : '\x1b[31m';
    console.log(pad(label, 45) + rpad(Math.round(ga).toLocaleString(), 12) + `${cc}${rpad('$' + gc.toFixed(4), 12)}\x1b[0m`);
  }

  console.log('─'.repeat(72));
  console.log(pad('AVERAGE', 45) + rpad(Math.round(avgInput).toLocaleString(), 12) + rpad(`$${avgCost.toFixed(4)}`, 12));
  console.log(`\n  Cheapest: $${minCost.toFixed(4)}  |  Most expensive: $${maxCost.toFixed(4)}`);
  console.log(`  Est. monthly (30 reps × 50 q/day): $${(avgCost * 30 * 50 * 30).toFixed(2)}`);
  console.log(`\n  ✅ ${passed} passed   ❌ ${failed} failed`);

  // ── Save outputs ──────────────────────────────────────────────────────────
  const ts = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
  const csvPath  = path.join(outDir, `pricing_${ts}.csv`);
  const htmlPath = path.join(outDir, `pricing_${ts}.html`);

  saveCSV(rows, csvPath);
  saveHTML(rows, htmlPath);

  console.log(`\n  📊 HTML report: ${htmlPath}`);
  console.log(`  📄 CSV data:    ${csvPath}\n`);
}

main().catch(err => {
  console.error('❌', err);
  process.exit(1);
});
