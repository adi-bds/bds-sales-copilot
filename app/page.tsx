'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────

type Message = {
  role: 'user' | 'assistant';
  content: string;
};

type GeoRegion = {
  code: string;
  flag: string;
  label: string;
  placeholder: string;
};

type MainCategory = {
  id: string;
  icon: string;
  label: string;
  description: string;
  placeholder: string;
  color: string;
};

// ─── Category & Geo Definitions ───────────────────────────────────────────

const MAIN_CATEGORIES: MainCategory[] = [
  {
    id: 'product',
    icon: '📦',
    label: 'Product Lookup & Info',
    description: 'Find the right product, specs, and pricing for any client',
    placeholder: 'Ask about a product, size, configuration, or price…',
    color: 'blue',
  },
  {
    id: 'email',
    icon: '✉️',
    label: 'Email Draft',
    description: 'Write a sales email for any stage of the process',
    placeholder: 'Describe the client situation and what the email should do…',
    color: 'violet',
  },
  {
    id: 'training',
    icon: '🎓',
    label: 'Training a Sales Rep',
    description: 'Learn the BDS product range, pricing, and sales process',
    placeholder: 'Ask anything — products, process, how to handle objections…',
    color: 'emerald',
  },
  {
    id: 'callprep',
    icon: '📞',
    label: 'Client Call Prep',
    description: 'Get intel, talking points, and order history before a call',
    placeholder: 'Enter a client name, email, or order number to pull their history…',
    color: 'amber',
  },
];

const GEO_REGIONS: GeoRegion[] = [
  { code: 'uk',  flag: '🇬🇧', label: 'UK',  placeholder: 'Ask about a UK client, quote, order, or inquiry…' },
  { code: 'us',  flag: '🇺🇸', label: 'US',  placeholder: 'Ask about a US client, order, or inquiry…' },
  { code: 'aus', flag: '🇦🇺', label: 'AUS', placeholder: 'Ask about an AU client, order, or inquiry…' },
  { code: 'nz',  flag: '🇳🇿', label: 'NZ',  placeholder: 'Ask about a NZ client, order, or inquiry…' },
  { code: 'ca',  flag: '🇨🇦', label: 'CA',  placeholder: 'Ask about a CA client, order, or inquiry…' },
];

const COLOR_STYLES: Record<string, { card: string; icon: string; badge: string }> = {
  blue:    { card: 'hover:border-blue-400 hover:shadow-blue-50',   icon: 'bg-blue-50 text-blue-600',    badge: 'bg-blue-100 text-blue-700' },
  violet:  { card: 'hover:border-violet-400 hover:shadow-violet-50', icon: 'bg-violet-50 text-violet-600', badge: 'bg-violet-100 text-violet-700' },
  emerald: { card: 'hover:border-emerald-400 hover:shadow-emerald-50', icon: 'bg-emerald-50 text-emerald-600', badge: 'bg-emerald-100 text-emerald-700' },
  amber:   { card: 'hover:border-amber-400 hover:shadow-amber-50',  icon: 'bg-amber-50 text-amber-600',  badge: 'bg-amber-100 text-amber-700' },
  geo:     { card: 'hover:border-slate-400 hover:shadow-slate-50',  icon: 'bg-slate-100 text-slate-600', badge: 'bg-slate-100 text-slate-700' },
};

// ─── Markdown renderer ────────────────────────────────────────────────────

type FormattedNode = React.ReactNode;

function formatInline(text: string): FormattedNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={i} className="bg-gray-100 px-1.5 py-0.5 rounded text-xs font-mono text-gray-800">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

function MessageContent({ content }: { content: string }) {
  if (!content) return null;

  const segments = content.split(/(```[\s\S]*?```)/g);

  return (
    <div className="space-y-0.5">
      {segments.map((segment, si) => {
        if (segment.startsWith('```') && segment.endsWith('```')) {
          const inner = segment.slice(3, -3);
          const newlineIdx = inner.indexOf('\n');
          const code = newlineIdx === -1 ? inner : inner.slice(newlineIdx + 1);
          return (
            <pre key={si} className="bg-slate-900 text-green-300 rounded-lg p-3 text-xs overflow-x-auto font-mono my-2 leading-relaxed">
              {code}
            </pre>
          );
        }

        const lines = segment.split('\n');
        return (
          <div key={si}>
            {lines.map((line, li) => {
              if (line.startsWith('### ')) return <h3 key={li} className="font-semibold text-sm mt-3 mb-0.5 text-gray-900">{formatInline(line.slice(4))}</h3>;
              if (line.startsWith('## '))  return <h2 key={li} className="font-semibold text-sm mt-4 mb-1 text-gray-900">{formatInline(line.slice(3))}</h2>;
              if (line.startsWith('# '))   return <h1 key={li} className="font-bold text-base mt-4 mb-1 text-gray-900">{formatInline(line.slice(2))}</h1>;
              if (/^-{3,}$/.test(line.trim()) || /^={3,}$/.test(line.trim())) return <hr key={li} className="my-2 border-gray-200" />;
              if (/^\|[\s\-:|]+\|/.test(line.trim())) return null;
              if (line.trim().startsWith('|')) return <code key={li} className="block text-xs font-mono text-gray-700 leading-5 whitespace-pre">{line}</code>;
              if (/^[\-\*] /.test(line)) return (
                <div key={li} className="flex gap-2 my-0.5 pl-1">
                  <span className="text-gray-400 flex-shrink-0 mt-[3px] text-xs leading-5">•</span>
                  <span className="text-sm leading-relaxed">{formatInline(line.slice(2))}</span>
                </div>
              );
              const numMatch = line.match(/^(\d+)\.\s(.+)/);
              if (numMatch) return (
                <div key={li} className="flex gap-2 my-0.5 pl-1">
                  <span className="text-blue-600 font-medium flex-shrink-0 text-xs mt-[3px] min-w-[1.25rem] leading-5">{numMatch[1]}.</span>
                  <span className="text-sm leading-relaxed">{formatInline(numMatch[2])}</span>
                </div>
              );
              if (line.trim() === '') return <div key={li} className="h-1.5" />;
              return <p key={li} className="text-sm leading-relaxed">{formatInline(line)}</p>;
            })}
          </div>
        );
      })}
    </div>
  );
}

// ─── Typing indicator ─────────────────────────────────────────────────────

function TypingDots() {
  return (
    <div className="flex gap-1 py-1">
      {[0, 150, 300].map((delay) => (
        <span key={delay} className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: `${delay}ms` }} />
      ))}
    </div>
  );
}

function SendIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
      <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
    </svg>
  );
}

// ─── Main component ───────────────────────────────────────────────────────

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput]       = useState('');
  const [isStreaming, setIsStreaming] = useState(false);

  // Category selection state
  const [activeCategory, setActiveCategory] = useState<MainCategory | null>(null);
  const [activeGeo, setActiveGeo]           = useState<GeoRegion | null>(null);
  const [geoExpanded, setGeoExpanded]       = useState(false);

  const messagesEndRef        = useRef<HTMLDivElement>(null);
  const messagesContainerRef  = useRef<HTMLDivElement>(null);
  const textareaRef           = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef    = useRef<AbortController | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus textarea when entering a category
  useEffect(() => {
    if ((activeCategory || activeGeo) && messages.length === 0) {
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [activeCategory, activeGeo, messages.length]);

  const currentPlaceholder =
    activeGeo?.placeholder ??
    activeCategory?.placeholder ??
    'Ask anything — products, emails, client prep, orders…';

  const sendMessage = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed || isStreaming) return;

      const userMessage: Message = { role: 'user', content: trimmed };
      const updatedMessages = [...messages, userMessage];

      setMessages([...updatedMessages, { role: 'assistant', content: '' }]);
      setInput('');
      setIsStreaming(true);

      if (textareaRef.current) textareaRef.current.style.height = 'auto';

      const controller = new AbortController();
      abortControllerRef.current = controller;

      // Build category context for smarter routing
      const categoryContext = activeGeo
        ? { category: 'geo', geo: activeGeo.code }
        : activeCategory
        ? { category: activeCategory.id, geo: null }
        : { category: null, geo: null };

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: updatedMessages, ...categoryContext }),
          signal: controller.signal,
        });

        if (!response.ok) throw new Error(`API returned ${response.status}`);

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let accumulated = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          accumulated += decoder.decode(value, { stream: true });
          const snapshot = accumulated;
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: 'assistant', content: snapshot };
            return updated;
          });
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return;
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: 'assistant', content: 'Something went wrong — please try again.' };
          return updated;
        });
      } finally {
        setIsStreaming(false);
        abortControllerRef.current = null;
      }
    },
    [messages, isStreaming, activeCategory, activeGeo]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
  };

  const handleNewChat = () => {
    abortControllerRef.current?.abort();
    setMessages([]);
    setInput('');
    setIsStreaming(false);
    setActiveCategory(null);
    setActiveGeo(null);
    setGeoExpanded(false);
  };

  const selectCategory = (cat: MainCategory) => {
    setActiveCategory(cat);
    setActiveGeo(null);
    setGeoExpanded(false);
    setMessages([]);
  };

  const selectGeo = (geo: GeoRegion) => {
    setActiveGeo(geo);
    setActiveCategory(null);
    setMessages([]);
  };

  // Active badge info for header
  const badgeLabel = activeGeo
    ? `${activeGeo.flag} ${activeGeo.label}`
    : activeCategory
    ? `${activeCategory.icon} ${activeCategory.label}`
    : null;

  const badgeStyle = activeGeo
    ? COLOR_STYLES.geo.badge
    : activeCategory
    ? COLOR_STYLES[activeCategory.color].badge
    : '';

  const inChat = messages.length > 0;

  return (
    <div className="flex flex-col h-screen bg-gray-50 font-sans">

      {/* ── Header ────────────────────────────────────────────────────── */}
      <header className="bg-slate-900 text-white px-5 py-3.5 flex items-center justify-between shadow-lg flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center font-bold text-sm select-none">
            B
          </div>
          <div>
            <h1 className="font-semibold text-base leading-tight">BDS Sales Copilot</h1>
            <p className="text-slate-400 text-xs">Backdropsource</p>
          </div>
          {badgeLabel && (
            <span className={`ml-1 px-2.5 py-1 rounded-full text-xs font-medium ${badgeStyle}`}>
              {badgeLabel}
            </span>
          )}
        </div>

        {(inChat || activeCategory || activeGeo) && (
          <button
            onClick={handleNewChat}
            className="text-slate-400 hover:text-white text-sm transition-colors px-3 py-1.5 rounded-lg hover:bg-slate-800"
          >
            New chat
          </button>
        )}
      </header>

      {/* ── Message / Home area ───────────────────────────────────────── */}
      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto">

        {/* ── Home screen (no category selected yet) ─────────────────── */}
        {!activeCategory && !activeGeo && !inChat && (
          <div className="max-w-2xl mx-auto px-4 py-10">
            <div className="text-center mb-8">
              <div className="w-16 h-16 bg-slate-900 rounded-2xl flex items-center justify-center text-3xl font-bold text-white mx-auto mb-4 select-none">
                B
              </div>
              <h2 className="text-2xl font-semibold text-gray-900 mb-2">BDS Sales Copilot</h2>
              <p className="text-gray-500 text-sm max-w-sm mx-auto">
                Select a category to get started
              </p>
            </div>

            {/* Main 4 categories — 2×2 grid */}
            <div className="grid grid-cols-2 gap-3 mb-3">
              {MAIN_CATEGORIES.map((cat) => {
                const s = COLOR_STYLES[cat.color];
                return (
                  <button
                    key={cat.id}
                    onClick={() => selectCategory(cat)}
                    className={`text-left p-4 bg-white rounded-xl border border-gray-200 hover:shadow-md transition-all group cursor-pointer ${s.card}`}
                  >
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-lg mb-3 ${s.icon}`}>
                      {cat.icon}
                    </div>
                    <div className="font-semibold text-gray-900 text-sm mb-1 group-hover:text-gray-700">
                      {cat.label}
                    </div>
                    <div className="text-gray-400 text-xs leading-relaxed">
                      {cat.description}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Geo-Based Inquiry — full-width expandable */}
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <button
                onClick={() => setGeoExpanded((v) => !v)}
                className="w-full text-left p-4 hover:bg-gray-50 transition-colors group flex items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center text-lg">
                    🌍
                  </div>
                  <div>
                    <div className="font-semibold text-gray-900 text-sm">Geo-Based Inquiry</div>
                    <div className="text-gray-400 text-xs mt-0.5">Look up orders and client info by region</div>
                  </div>
                </div>
                <svg
                  className={`w-4 h-4 text-gray-400 transition-transform flex-shrink-0 ${geoExpanded ? 'rotate-180' : ''}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {geoExpanded && (
                <div className="px-4 pb-4 grid grid-cols-5 gap-2 border-t border-gray-100 pt-3">
                  {GEO_REGIONS.map((geo) => (
                    <button
                      key={geo.code}
                      onClick={() => selectGeo(geo)}
                      className="flex flex-col items-center gap-1.5 p-3 rounded-xl border border-gray-200 hover:border-slate-400 hover:bg-slate-50 hover:shadow-sm transition-all cursor-pointer"
                    >
                      <span className="text-2xl">{geo.flag}</span>
                      <span className="text-xs font-semibold text-gray-700">{geo.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Category selected, no messages yet — show empty chat state ─ */}
        {(activeCategory || activeGeo) && !inChat && (
          <div className="max-w-3xl mx-auto px-4 py-12 text-center">
            <div className="text-4xl mb-3">
              {activeGeo ? activeGeo.flag : activeCategory!.icon}
            </div>
            <h3 className="text-lg font-semibold text-gray-800 mb-1">
              {activeGeo ? `${activeGeo.label} Inquiry` : activeCategory!.label}
            </h3>
            <p className="text-gray-400 text-sm">
              {activeGeo
                ? `Ask about ${activeGeo.label} clients, orders, or quotes below`
                : activeCategory!.description}
            </p>
          </div>
        )}

        {/* ── Message list ───────────────────────────────────────────── */}
        {inChat && (
          <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex items-start gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {msg.role === 'assistant' && (
                  <div className="w-7 h-7 bg-slate-900 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0 mt-0.5 select-none">
                    B
                  </div>
                )}
                <div
                  className={`rounded-2xl px-4 py-3 ${
                    msg.role === 'user'
                      ? 'bg-blue-600 text-white rounded-br-sm max-w-[75%]'
                      : 'bg-white text-gray-800 rounded-bl-sm border border-gray-200 shadow-sm flex-1 min-w-0'
                  }`}
                >
                  {msg.role === 'user' ? (
                    <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                  ) : msg.content === '' && isStreaming ? (
                    <TypingDots />
                  ) : (
                    <MessageContent content={msg.content} />
                  )}
                </div>
                {msg.role === 'user' && (
                  <div className="w-7 h-7 bg-blue-100 rounded-full flex items-center justify-center text-blue-600 text-xs font-bold flex-shrink-0 mt-0.5 select-none">
                    R
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* ── Input bar (only shown when a category is active) ──────────── */}
      {(activeCategory || activeGeo) && (
        <div className="border-t border-gray-200 bg-white px-4 py-4 flex-shrink-0">
          <div className="max-w-3xl mx-auto">
            <div className="flex gap-3 items-end">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={handleTextareaChange}
                onKeyDown={handleKeyDown}
                placeholder={currentPlaceholder}
                rows={1}
                disabled={isStreaming}
                className="flex-1 resize-none rounded-xl border border-gray-300 px-4 py-3 text-sm text-gray-900 bg-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-50 disabled:text-gray-400 min-h-[48px] max-h-[200px] overflow-y-auto leading-relaxed"
              />
              <button
                onClick={() => sendMessage(input)}
                disabled={!input.trim() || isStreaming}
                aria-label="Send message"
                className="h-12 w-12 bg-blue-600 text-white rounded-xl flex items-center justify-center hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0"
              >
                <SendIcon />
              </button>
            </div>
            <p className="text-center text-gray-400 text-xs mt-2.5">
              Enter to send · Shift+Enter for new line
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
