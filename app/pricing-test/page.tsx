'use client';

import { useState, useRef } from 'react';

const PRICE_INPUT  = 3.00;
const PRICE_OUTPUT = 15.00;

interface TestCase {
  category_label: string;
  api_category:   string | null;
  api_geo:        string | null;
  prompt:         string;
}

const TEST_CASES: TestCase[] = [
  { category_label: 'Product — common (10x10 booth)',    api_category: 'product',  api_geo: null, prompt: 'What 10x10 booth kits do you have and what are the prices?' },
  { category_label: 'Product — common (media wall)',     api_category: 'product',  api_geo: null, prompt: 'Client wants a tension fabric media wall for a trade show. What sizes and prices do we have?' },
  { category_label: 'Product — size variants',           api_category: 'product',  api_geo: null, prompt: 'What are the size variants for the Custom Wall-Hanging Backdrop with Clamps?' },
  { category_label: 'Product — niche (sky tube)',        api_category: 'product',  api_geo: null, prompt: 'Client wants a circular hanging banner from the ceiling for a trade show, seen it called a sky tube. Pricing?' },
  { category_label: 'Product — niche (inflatable)',      api_category: 'product',  api_geo: null, prompt: "Client running a car dealership wants one of those inflatable dancing tube men out front. Do we sell those?" },
  { category_label: 'Product — niche (meeting pod)',     api_category: 'product',  api_geo: null, prompt: 'Client wants a semi-private branded meeting area inside their trade show booth — like an enclosed pod. What do we have?' },
  { category_label: 'Product — niche (truss tower)',     api_category: 'product',  api_geo: null, prompt: 'Client wants a tall freestanding branded tower printed on all 4 sides. What is our option for that?' },
  { category_label: 'Email — complaint (colour mismatch)', api_category: 'email', api_geo: null, prompt: "Client received their order and the fabric has a colour mismatch — it looks washed out vs what they approved. Draft the first reply." },
  { category_label: 'Email — complaint (missing item)',  api_category: 'email',    api_geo: null, prompt: "Client says they ordered a booth kit but the carry case didn't arrive. First email response." },
  { category_label: 'Email — quote follow-up',           api_category: 'email',    api_geo: null, prompt: 'I sent a quote to Sarah at ABC Events 5 days ago for a 10x10 booth kit at $1,450. No response. Write a follow-up email.' },
  { category_label: 'Email — UK complaint',              api_category: 'email',    api_geo: 'uk', prompt: "UK client says their banner arrived damaged — the graphic is torn on one side. Draft the first response." },
  { category_label: 'Call prep — B2B client',            api_category: 'callprep', api_geo: null, prompt: 'I have a call with Global Vision Events in 20 minutes. What do we know about them and what should I lead with?' },
  { category_label: 'Call prep — objection handling',    api_category: 'callprep', api_geo: null, prompt: 'Client on the phone says they found the same product cheaper on another site. How do I handle this?' },
  { category_label: 'Training — product overview',       api_category: 'training', api_geo: null, prompt: "I'm a new rep. Walk me through the main product categories we sell and when to recommend each one." },
  { category_label: 'Training — delivery timeline',      api_category: 'training', api_geo: null, prompt: 'What do I tell clients when they ask how long delivery takes? What are all the options?' },
  { category_label: 'General — rush order',              api_category: null,       api_geo: null, prompt: "Client needs a backdrop for an event this Friday. Today is Monday. Is that possible?" },
  { category_label: 'General — replacement fabric',      api_category: null,       api_geo: null, prompt: 'Client already has a frame and just wants a replacement fabric from us. How do I quote this?' },
  { category_label: 'General — outdoor use',             api_category: null,       api_geo: null, prompt: "Client wants to use a fabric backdrop outdoors at a street event. Can we guarantee it won't get damaged in light rain?" },
  { category_label: 'General — pole pockets',            api_category: null,       api_geo: null, prompt: 'Client wants pole pockets on all four sides of a banner with envelope corners for pipe and drape. Can we do that?' },
  { category_label: 'UK — pricing question',             api_category: null,       api_geo: 'uk', prompt: "UK client asking about pricing for a 3m x 2.3m tension fabric display. What do we charge?" },
  { category_label: 'Order lookup — by order number',    api_category: null,       api_geo: null, prompt: 'Can you pull up order US#16111 for me?' },
  { category_label: 'Order lookup — by name',            api_category: null,       api_geo: null, prompt: 'What has Jennifer Smith ordered with us before?' },
];

interface Result {
  category_label: string;
  input:    number;
  output:   number;
  cost:     number;
  duration: number;
  error?:   string;
  status:   'pending' | 'running' | 'done' | 'error';
}

function calcCost(input: number, output: number) {
  return (input / 1_000_000) * PRICE_INPUT + (output / 1_000_000) * PRICE_OUTPUT;
}

function costColor(cost: number): string {
  if (cost < 0.02) return '#15803d';
  if (cost < 0.05) return '#b45309';
  return '#dc2626';
}

async function runQuery(tc: TestCase): Promise<{ input: number; output: number; duration: number }> {
  const t0 = Date.now();
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: tc.prompt }],
      category: tc.api_category,
      geo: tc.api_geo,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let raw = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += dec.decode(value, { stream: true });
  }
  const duration = Date.now() - t0;
  const m = raw.match(/__USAGE__([\s\S]+?)__END__/);
  if (!m) throw new Error('No usage block in response');
  const u = JSON.parse(m[1]);
  return { input: u.input, output: u.output, duration };
}

export default function PricingTest() {
  const [results, setResults] = useState<Result[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const abortRef = useRef(false);

  function initResults(): Result[] {
    return TEST_CASES.map(tc => ({
      category_label: tc.category_label,
      input: 0, output: 0, cost: 0, duration: 0,
      status: 'pending' as Result['status'],
    }));
  }

  async function runAll() {
    abortRef.current = false;
    setDone(false);
    const rows = initResults();
    setResults([...rows]);
    setRunning(true);

    for (let i = 0; i < TEST_CASES.length; i++) {
      if (abortRef.current) break;
      rows[i] = { ...rows[i], status: 'running' as Result['status'] };
      setResults([...rows]);

      try {
        const { input, output, duration } = await runQuery(TEST_CASES[i]);
        rows[i] = { ...rows[i], input, output, cost: calcCost(input, output), duration, status: 'done' as Result['status'] };
      } catch (e: unknown) {
        rows[i] = { ...rows[i], error: e instanceof Error ? e.message : String(e), status: 'error' as Result['status'] };
      }
      setResults([...rows]);
      await new Promise(r => setTimeout(r, 300));
    }
    setRunning(false);
    setDone(true);
  }

  function stop() { abortRef.current = true; }

  const doneRows  = results.filter(r => r.status === 'done');
  const avgCost   = doneRows.length ? doneRows.reduce((s, r) => s + r.cost, 0) / doneRows.length : 0;
  const avgInput  = doneRows.length ? doneRows.reduce((s, r) => s + r.input, 0) / doneRows.length : 0;
  const maxInput  = Math.max(...doneRows.map(r => r.input), 1);

  // Group summary
  const groups = new Map<string, Result[]>();
  for (const r of doneRows) {
    const prefix = r.category_label.split(' — ')[0].trim();
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix)!.push(r);
  }
  const groupSummary = [...groups.entries()].map(([label, rows]) => ({
    label,
    avgCost:  rows.reduce((s, r) => s + r.cost, 0) / rows.length,
    avgInput: rows.reduce((s, r) => s + r.input, 0) / rows.length,
    count: rows.length,
  })).sort((a, b) => b.avgCost - a.avgCost);

  function downloadCSV() {
    const lines = ['Category,Input Tokens,Output Tokens,Cost USD,Duration ms'];
    for (const r of results.filter(r => r.status === 'done')) {
      lines.push(`"${r.category_label}",${r.input},${r.output},${r.cost.toFixed(5)},${r.duration}`);
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `bds_pricing_${new Date().toISOString().slice(0,10)}.csv`; a.click();
  }

  return (
    <div style={{ fontFamily: '-apple-system, Arial, sans-serif', background: '#f0f4f8', minHeight: '100vh', padding: '32px' }}>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ fontSize: 24, color: '#1b2a4a', marginBottom: 4 }}>BDS Copilot — Query Pricing Test</h1>
          <p style={{ color: '#666', fontSize: 14 }}>Runs {TEST_CASES.length} queries against the live API and measures token usage + cost. Make sure the dev server is running.</p>
        </div>

        {/* Controls */}
        <div style={{ marginBottom: 28, display: 'flex', gap: 12, alignItems: 'center' }}>
          <button
            onClick={runAll}
            disabled={running}
            style={{ background: running ? '#94a3b8' : '#1b2a4a', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 24px', fontSize: 15, fontWeight: 600, cursor: running ? 'not-allowed' : 'pointer' }}
          >
            {running ? `Running… (${doneRows.length + results.filter(r => r.status === 'error').length}/${TEST_CASES.length})` : done ? '↺ Run Again' : '▶ Run All Tests'}
          </button>
          {running && (
            <button onClick={stop} style={{ background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 18px', fontSize: 14, cursor: 'pointer' }}>
              ■ Stop
            </button>
          )}
          {done && doneRows.length > 0 && (
            <button onClick={downloadCSV} style={{ background: '#fff', color: '#1b2a4a', border: '1px solid #c8d4e8', borderRadius: 8, padding: '10px 18px', fontSize: 14, cursor: 'pointer' }}>
              ⬇ Download CSV
            </button>
          )}
        </div>

        {results.length > 0 && (
          <>
            {/* Summary cards */}
            {doneRows.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
                {[
                  { val: `$${avgCost.toFixed(4)}`, label: 'Average cost per query' },
                  { val: Math.round(avgInput).toLocaleString(), label: 'Average input tokens' },
                  { val: `$${(avgCost * 30 * 50 * 30).toFixed(0)}`, label: 'Est. monthly (30 reps × 50/day)' },
                ].map(s => (
                  <div key={s.label} style={{ background: '#fff', borderRadius: 10, padding: '20px 24px', boxShadow: '0 1px 4px rgba(0,0,0,.08)', textAlign: 'center' }}>
                    <div style={{ fontSize: 28, fontWeight: 700, color: '#1b2a4a' }}>{s.val}</div>
                    <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>{s.label}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Group summary */}
            {groupSummary.length > 0 && (
              <div style={{ background: '#fff', borderRadius: 10, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,.08)', marginBottom: 24 }}>
                <h2 style={{ fontSize: 15, color: '#2e5fa3', fontWeight: 600, marginBottom: 16 }}>Average Cost by Query Type</h2>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#1b2a4a', color: '#fff' }}>
                      {['Query Type', 'Avg Input Tokens', 'Avg Cost', 'Cost per 50 queries'].map(h => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {groupSummary.map((g, i) => (
                      <tr key={g.label} style={{ background: i % 2 === 1 ? '#f8fafc' : '#fff' }}>
                        <td style={{ padding: '8px 12px', borderBottom: '1px solid #eee' }}>{g.label}</td>
                        <td style={{ padding: '8px 12px', borderBottom: '1px solid #eee' }}>{Math.round(g.avgInput).toLocaleString()}</td>
                        <td style={{ padding: '8px 12px', borderBottom: '1px solid #eee', fontWeight: 600, color: costColor(g.avgCost) }}>${g.avgCost.toFixed(4)}</td>
                        <td style={{ padding: '8px 12px', borderBottom: '1px solid #eee' }}>${(g.avgCost * 50).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Per-query table */}
            <div style={{ background: '#fff', borderRadius: 10, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,.08)' }}>
              <h2 style={{ fontSize: 15, color: '#2e5fa3', fontWeight: 600, marginBottom: 16 }}>All Queries</h2>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#1b2a4a', color: '#fff' }}>
                    <th style={{ padding: '8px 12px', textAlign: 'left', width: 240 }}>Query</th>
                    <th style={{ padding: '8px 12px', textAlign: 'left' }}>Token Usage</th>
                    <th style={{ padding: '8px 12px', width: 80 }}>Cost</th>
                    <th style={{ padding: '8px 12px', width: 60 }}>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => (
                    <tr key={i} style={{ background: i % 2 === 1 ? '#f8fafc' : '#fff' }}>
                      <td style={{ padding: '8px 12px', borderBottom: '1px solid #eee', fontSize: 12, color: '#333', verticalAlign: 'middle' }}>
                        {r.category_label}
                      </td>
                      <td style={{ padding: '8px 12px', borderBottom: '1px solid #eee', verticalAlign: 'middle' }}>
                        {r.status === 'pending' && <span style={{ color: '#aaa', fontSize: 12 }}>Waiting…</span>}
                        {r.status === 'running' && <span style={{ color: '#2e5fa3', fontSize: 12 }}>⏳ Running…</span>}
                        {r.status === 'error'   && <span style={{ color: '#dc2626', fontSize: 12 }}>❌ {r.error}</span>}
                        {r.status === 'done' && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{ flex: 1, height: 16, background: '#e8eef7', borderRadius: 3, overflow: 'hidden', position: 'relative', minWidth: 80 }}>
                              <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${(r.input / maxInput * 100).toFixed(1)}%`, background: '#2e5fa3', borderRadius: 3 }} />
                            </div>
                            <span style={{ fontSize: 11, color: '#666', whiteSpace: 'nowrap' }}>{r.input.toLocaleString()} in / {r.output} out</span>
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '8px 12px', borderBottom: '1px solid #eee', textAlign: 'right', fontWeight: 600, color: r.status === 'done' ? costColor(r.cost) : '#aaa' }}>
                        {r.status === 'done' ? `$${r.cost.toFixed(4)}` : '—'}
                      </td>
                      <td style={{ padding: '8px 12px', borderBottom: '1px solid #eee', textAlign: 'right', fontSize: 12, color: '#888' }}>
                        {r.status === 'done' ? `${(r.duration / 1000).toFixed(1)}s` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {results.length === 0 && (
          <div style={{ background: '#fff', borderRadius: 10, padding: 40, textAlign: 'center', color: '#888', boxShadow: '0 1px 4px rgba(0,0,0,.08)' }}>
            Click <strong>Run All Tests</strong> to start. Each query hits <code>/api/chat</code> and records token usage + cost.
          </div>
        )}
      </div>
    </div>
  );
}
