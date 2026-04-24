'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────

type Message = { role: 'user' | 'assistant'; content: string };

type NavItem = {
  id: string;
  icon: React.ReactNode;
  label: string;
  placeholder: string;
  geo?: boolean;
};

type GeoRegion = {
  code: string;
  flag: string;
  label: string;
  placeholder: string;
};

// ─── Icons ────────────────────────────────────────────────────────────────

const IconBox      = () => <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10"/></svg>;
const IconMail     = () => <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>;
const IconAcademic = () => <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M12 14l9-5-9-5-9 5 9 5z"/><path strokeLinecap="round" strokeLinejoin="round" d="M12 14l6.16-3.422a12.083 12.083 0 01.665 6.479A11.952 11.952 0 0012 20.055a11.952 11.952 0 00-6.824-2.998 12.078 12.078 0 01.665-6.479L12 14z"/></svg>;
const IconPhone    = () => <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/></svg>;
const IconGlobe    = () => <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>;
const IconChevron  = ({ open }: { open: boolean }) => <svg className={`w-3.5 h-3.5 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/></svg>;
const IconPlus     = () => <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/></svg>;
const IconSend     = () => <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>;

// ─── Navigation config ─────────────────────────────────────────────────────

const NAV_ITEMS: NavItem[] = [
  { id: 'product',  icon: <IconBox />,      label: 'Product Lookup',     placeholder: 'Ask about a product, spec, size, or price…' },
  { id: 'email',    icon: <IconMail />,     label: 'Email Draft',        placeholder: 'Describe the client situation and email goal…' },
  { id: 'training', icon: <IconAcademic />, label: 'Rep Training',       placeholder: 'Ask anything — products, process, objections…' },
  { id: 'callprep', icon: <IconPhone />,    label: 'Client Call Prep',   placeholder: 'Enter a client name, email, or order number…' },
  { id: 'geo',      icon: <IconGlobe />,    label: 'Geo-Based Inquiry',  placeholder: 'Select a region below…', geo: true },
];

const GEO_REGIONS: GeoRegion[] = [
  { code: 'uk',  flag: '🇬🇧', label: 'UK',        placeholder: 'Ask about a UK client, quote, order, or email…' },
  { code: 'us',  flag: '🇺🇸', label: 'US',        placeholder: 'Ask about a US client, order, or inquiry…' },
  { code: 'aus', flag: '🇦🇺', label: 'Australia', placeholder: 'Ask about an AU client, order, or inquiry…' },
  { code: 'nz',  flag: '🇳🇿', label: 'New Zealand', placeholder: 'Ask about a NZ client, order, or inquiry…' },
  { code: 'ca',  flag: '🇨🇦', label: 'Canada',    placeholder: 'Ask about a CA client, order, or inquiry…' },
];

// ─── Markdown renderer ────────────────────────────────────────────────────

function formatInline(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
      return <strong key={i} className="font-semibold text-slate-900">{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2)
      return <code key={i} className="bg-slate-100 px-1.5 py-0.5 rounded text-xs font-mono text-slate-700">{part.slice(1, -1)}</code>;
    return <span key={i}>{part}</span>;
  });
}

function MessageContent({ content }: { content: string }) {
  if (!content) return null;
  return (
    <div className="space-y-0.5">
      {content.split(/(```[\s\S]*?```)/g).map((seg, si) => {
        if (seg.startsWith('```') && seg.endsWith('```')) {
          const inner = seg.slice(3, -3);
          const nl = inner.indexOf('\n');
          return <pre key={si} className="bg-slate-950 text-emerald-400 rounded-xl p-4 text-xs overflow-x-auto font-mono my-3 leading-relaxed">{nl === -1 ? inner : inner.slice(nl + 1)}</pre>;
        }
        return (
          <div key={si}>
            {seg.split('\n').map((line, li) => {
              if (line.startsWith('### ')) return <h3 key={li} className="font-semibold text-sm mt-3 mb-0.5 text-slate-900">{formatInline(line.slice(4))}</h3>;
              if (line.startsWith('## '))  return <h2 key={li} className="font-semibold text-sm mt-4 mb-1 text-slate-900">{formatInline(line.slice(3))}</h2>;
              if (line.startsWith('# '))   return <h1 key={li} className="font-bold text-base mt-4 mb-1 text-slate-900">{formatInline(line.slice(2))}</h1>;
              if (/^-{3,}$|^={3,}$/.test(line.trim())) return <hr key={li} className="my-3 border-slate-200" />;
              if (/^\|[\s\-:|]+\|/.test(line.trim())) return null;
              if (line.trim().startsWith('|')) return <code key={li} className="block text-xs font-mono text-slate-600 leading-5 whitespace-pre">{line}</code>;
              if (/^[\-\*] /.test(line)) return (
                <div key={li} className="flex gap-2 my-0.5 pl-1">
                  <span className="text-slate-300 flex-shrink-0 mt-[3px] text-xs leading-5">•</span>
                  <span className="text-sm leading-relaxed text-slate-700">{formatInline(line.slice(2))}</span>
                </div>
              );
              const nm = line.match(/^(\d+)\.\s(.+)/);
              if (nm) return (
                <div key={li} className="flex gap-2 my-0.5 pl-1">
                  <span className="text-red-500 font-medium flex-shrink-0 text-xs mt-[3px] min-w-[1.25rem] leading-5">{nm[1]}.</span>
                  <span className="text-sm leading-relaxed text-slate-700">{formatInline(nm[2])}</span>
                </div>
              );
              if (line.trim() === '') return <div key={li} className="h-1.5" />;
              return <p key={li} className="text-sm leading-relaxed text-slate-700">{formatInline(line)}</p>;
            })}
          </div>
        );
      })}
    </div>
  );
}

function TypingDots() {
  return (
    <div className="flex gap-1.5 py-1">
      {[0, 150, 300].map((d) => (
        <span key={d} className="w-1.5 h-1.5 bg-slate-300 rounded-full animate-bounce" style={{ animationDelay: `${d}ms` }} />
      ))}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────

export default function Home() {
  const [messages, setMessages]     = useState<Message[]>([]);
  const [input, setInput]           = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeNav, setActiveNav]   = useState<NavItem | null>(null);
  const [activeGeo, setActiveGeo]   = useState<GeoRegion | null>(null);
  const [geoOpen, setGeoOpen]       = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef    = useRef<HTMLTextAreaElement>(null);
  const abortRef       = useRef<AbortController | null>(null);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => {
    if (activeNav && messages.length === 0) setTimeout(() => textareaRef.current?.focus(), 80);
  }, [activeNav, messages.length]);

  const placeholder = activeGeo?.placeholder ?? activeNav?.placeholder ?? 'Select a category to get started…';

  const selectNav = (item: NavItem) => {
    if (item.geo) { setGeoOpen((v) => !v); return; }
    setActiveNav(item);
    setActiveGeo(null);
    setMessages([]);
    setInput('');
  };

  const selectGeo = (geo: GeoRegion) => {
    setActiveGeo(geo);
    setActiveNav(NAV_ITEMS.find((n) => n.geo) ?? null);
    setMessages([]);
    setInput('');
  };

  const startNewChat = () => {
    abortRef.current?.abort();
    setMessages([]);
    setInput('');
    setIsStreaming(false);
    setActiveNav(null);
    setActiveGeo(null);
  };

  const sendMessage = useCallback(async (content: string) => {
    const trimmed = content.trim();
    if (!trimmed || isStreaming) return;

    const userMsg: Message = { role: 'user', content: trimmed };
    const updated = [...messages, userMsg];
    setMessages([...updated, { role: 'assistant', content: '' }]);
    setInput('');
    setIsStreaming(true);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const category = activeGeo ? 'geo' : activeNav?.id ?? null;
    const geo = activeGeo?.code ?? null;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: updated, category, geo }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`${res.status}`);

      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let acc = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
        const snap = acc;
        setMessages((prev) => { const u = [...prev]; u[u.length - 1] = { role: 'assistant', content: snap }; return u; });
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'AbortError') return;
      setMessages((prev) => { const u = [...prev]; u[u.length - 1] = { role: 'assistant', content: 'Something went wrong — please try again.' }; return u; });
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [messages, isStreaming, activeNav, activeGeo]);

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input); }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
  };

  const headerLabel = activeGeo
    ? `${activeGeo.flag} ${activeGeo.label}`
    : activeNav?.label ?? 'BDS Sales Copilot';

  const isReady = !!(activeNav && (!activeNav.geo || activeGeo));

  return (
    <div className="flex h-screen font-sans overflow-hidden" style={{background:'#0B1A2E'}}>

      {/* ── Sidebar ───────────────────────────────────────────────────── */}
      <aside className="w-56 flex-shrink-0 flex flex-col border-r border-white/5" style={{background:'#0B1A2E'}}>

        {/* Logo */}
        <div className="px-4 pt-5 pb-4">
          <svg viewBox="0 0 200 36" xmlns="http://www.w3.org/2000/svg" className="w-44 h-auto">
            <rect x="0" y="0" width="104" height="36" fill="#1B2A4A"/>
            <rect x="104" y="0" width="96" height="36" fill="#CC1F1F"/>
            <text x="52" y="23.5" textAnchor="middle" fill="white" fontFamily="Arial, sans-serif" fontSize="11.5" fontWeight="700" letterSpacing="1.2">BACKDROP</text>
            <text x="152" y="23.5" textAnchor="middle" fill="white" fontFamily="Arial, sans-serif" fontSize="11.5" fontWeight="700" letterSpacing="1.2">SOURCE</text>
          </svg>
          <div className="text-slate-500 text-[10px] mt-1.5 font-medium tracking-wide uppercase">Sales Copilot</div>
        </div>

        {/* New chat */}
        <div className="px-3 mb-4">
          <button
            onClick={startNewChat}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/8 transition-all text-sm"
          >
            <IconPlus />
            <span>New chat</span>
          </button>
        </div>

        {/* Nav items */}
        <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto">
          <p className="text-slate-500 text-[10px] font-semibold uppercase tracking-wider px-2 mb-2">Categories</p>

          {NAV_ITEMS.map((item) => {
            const isGeoParent = item.geo;
            const isActive = !isGeoParent
              ? activeNav?.id === item.id
              : !!activeGeo;

            return (
              <div key={item.id}>
                <button
                  onClick={() => selectNav(item)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm transition-all ${
                    isActive
                      ? 'bg-red-600/15 text-red-400 font-medium'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
                  }`}
                >
                  <span className={isActive ? 'text-red-400' : 'text-slate-500'}>{item.icon}</span>
                  <span className="flex-1 text-left">{item.label}</span>
                  {isGeoParent && <IconChevron open={geoOpen} />}
                </button>

                {/* Geo sub-items */}
                {isGeoParent && geoOpen && (
                  <div className="ml-3 mt-0.5 space-y-0.5 border-l border-white/10 pl-3">
                    {GEO_REGIONS.map((geo) => (
                      <button
                        key={geo.code}
                        onClick={() => selectGeo(geo)}
                        className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-sm transition-all ${
                          activeGeo?.code === geo.code
                            ? 'bg-red-600/15 text-red-400 font-medium'
                            : 'text-slate-500 hover:text-slate-200 hover:bg-white/5'
                        }`}
                      >
                        <span className="text-base leading-none">{geo.flag}</span>
                        <span>{geo.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Bottom */}
        <div className="p-3 border-t border-white/5">
          <div className="bg-gradient-to-br from-red-600 to-red-800 rounded-xl p-3">
            <div className="text-white font-semibold text-xs mb-0.5">Sales Copilot</div>
            <div className="text-red-200 text-xs leading-relaxed">17,771 orders across all regions</div>
          </div>
        </div>
      </aside>

      {/* ── Main area ─────────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col bg-slate-50 overflow-hidden">

        {/* Header */}
        <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="font-semibold text-slate-900 text-base">{headerLabel}</h2>
            {isReady && messages.length > 0 && (
              <span className="px-2 py-0.5 bg-red-50 text-red-600 text-xs font-medium rounded-full border border-red-100">
                Active
              </span>
            )}
          </div>
          {messages.length > 0 && (
            <button
              onClick={startNewChat}
              className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-700 transition-colors"
            >
              <IconPlus />
              <span>New chat</span>
            </button>
          )}
        </header>

        {/* Messages / empty state */}
        <div className="flex-1 overflow-y-auto">

          {/* Welcome — no category selected */}
          {!activeNav && !activeGeo && (
            <div className="flex flex-col items-center justify-center h-full px-8 text-center">
              <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" className="w-16 h-16 mb-5">
                <circle cx="50" cy="50" r="50" fill="#111"/>
                <clipPath id="bsTop"><polygon points="0,0 100,0 100,100 0,0"/></clipPath>
                <clipPath id="bsBot"><polygon points="0,0 100,100 0,100 0,0"/></clipPath>
                <circle cx="50" cy="50" r="47" fill="#1B2D6E" clipPath="url(#bsTop)"/>
                <circle cx="50" cy="50" r="47" fill="#9B1B3B" clipPath="url(#bsBot)"/>
                <text x="27" y="65" fontFamily="Arial Black, Arial, sans-serif" fontWeight="900" fontSize="42" fill="white">B</text>
                <text x="54" y="65" fontFamily="Arial Black, Arial, sans-serif" fontWeight="900" fontSize="42" fill="white">S</text>
              </svg>
              <h3 className="text-xl font-semibold text-slate-900 mb-2">Welcome to BDS Sales Copilot</h3>
              <p className="text-slate-400 text-sm max-w-xs leading-relaxed">
                Select a category from the sidebar to get started with product lookups, email drafts, training, or client prep.
              </p>
            </div>
          )}

          {/* Category selected, no messages */}
          {isReady && messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full px-8 text-center">
              <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center text-2xl shadow-sm border border-slate-200 mb-4 select-none">
                {activeGeo ? activeGeo.flag : activeNav?.id === 'product' ? '📦' : activeNav?.id === 'email' ? '✉️' : activeNav?.id === 'training' ? '🎓' : '📞'}
              </div>
              <h3 className="text-base font-semibold text-slate-800 mb-1">{headerLabel}</h3>
              <p className="text-slate-400 text-sm">{placeholder}</p>
            </div>
          )}

          {/* Messages */}
          {messages.length > 0 && (
            <div className="max-w-3xl mx-auto px-6 py-6 space-y-5">
              {messages.map((msg, i) => (
                <div key={i} className={`flex items-start gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.role === 'assistant' && (
                    <div className="w-7 h-7 bg-red-600 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0 mt-0.5 select-none">
                      B
                    </div>
                  )}
                  <div className={`rounded-2xl px-4 py-3 ${
                    msg.role === 'user'
                      ? 'text-white rounded-br-sm max-w-[72%]'
                      : 'bg-white text-slate-700 rounded-bl-sm border border-slate-200 shadow-sm flex-1 min-w-0'
                  }`} style={msg.role === 'user' ? {background:'#1B3A6B'} : {}}>
                    {msg.role === 'user'
                      ? <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                      : msg.content === '' && isStreaming
                      ? <TypingDots />
                      : <MessageContent content={msg.content} />
                    }
                  </div>
                  {msg.role === 'user' && (
                    <div className="w-7 h-7 bg-red-100 rounded-full flex items-center justify-center text-red-600 text-xs font-bold flex-shrink-0 mt-0.5 select-none">
                      R
                    </div>
                  )}
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input bar */}
        <div className="bg-white border-t border-slate-200 px-6 py-4 flex-shrink-0">
          <div className="max-w-3xl mx-auto">
            <div className={`flex gap-3 items-end bg-slate-50 rounded-2xl border transition-all px-4 py-3 ${
              isReady
                ? 'border-slate-300 focus-within:border-red-400 focus-within:ring-2 focus-within:ring-red-100'
                : 'border-slate-200 opacity-50'
            }`}>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={handleChange}
                onKeyDown={handleKey}
                placeholder={placeholder}
                rows={1}
                disabled={isStreaming || !isReady}
                className="flex-1 resize-none bg-transparent text-sm text-slate-900 placeholder-slate-400 focus:outline-none disabled:cursor-not-allowed min-h-[24px] max-h-[180px] overflow-y-auto leading-relaxed"
              />
              <button
                onClick={() => sendMessage(input)}
                disabled={!input.trim() || isStreaming || !isReady}
                aria-label="Send"
                className="w-8 h-8 bg-red-600 text-white rounded-xl flex items-center justify-center hover:bg-red-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex-shrink-0"
              >
                <IconSend />
              </button>
            </div>
            <p className="text-center text-slate-400 text-xs mt-2">
              Enter to send · Shift+Enter for new line
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
