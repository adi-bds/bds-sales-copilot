'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────

type Message = {
  role: 'user' | 'assistant';
  content: string;
};

// ─── Quick-action prompts shown on the empty state ─────────────────────────

const QUICK_PROMPTS = [
  {
    icon: '🔍',
    label: 'Product lookup',
    description: 'Find the right product for any use case',
    prompt:
      'A client needs a professional freestanding display for a 10×10 trade show booth. Budget is around $1,500 and they want something easy to set up. What should I recommend?',
  },
  {
    icon: '✉️',
    label: 'Draft an email',
    description: 'Write a sales email for any stage',
    prompt:
      "Draft a follow-up email for a client who requested a quote for 5 tension fabric media walls 3 days ago and hasn't responded yet.",
  },
  {
    icon: '🇬🇧',
    label: 'UK inquiry',
    description: 'Handle a UK client question',
    prompt:
      'A UK client emailed asking about a 3m backdrop for a corporate exhibition in London next month. Draft a first reply in the BDS UK style.',
  },
  {
    icon: '👥',
    label: 'Client call prep',
    description: 'Get talking points before a call',
    prompt:
      "I have a call in 10 minutes with a returning B2B client. What should I know about our top accounts and what should I be pitching to recurring clients?",
  },
  {
    icon: '📋',
    label: 'Train me',
    description: 'Learn the BDS product range',
    prompt:
      "I'm new to BDS. Walk me through the main product categories and which ones to recommend first for trade show clients.",
  },
];

// ─── Markdown renderer ────────────────────────────────────────────────────
// Handles the most common patterns in Claude's responses without any
// external dependencies: headers, bold, inline code, bullet/numbered lists,
// code blocks, table rows, and horizontal rules.

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

  // Split by fenced code blocks first so we can render them as <pre>
  const segments = content.split(/(```[\s\S]*?```)/g);

  return (
    <div className="space-y-0.5">
      {segments.map((segment, si) => {
        // Code block
        if (segment.startsWith('```') && segment.endsWith('```')) {
          const inner = segment.slice(3, -3);
          const newlineIdx = inner.indexOf('\n');
          const code = newlineIdx === -1 ? inner : inner.slice(newlineIdx + 1);
          return (
            <pre
              key={si}
              className="bg-slate-900 text-green-300 rounded-lg p-3 text-xs overflow-x-auto font-mono my-2 leading-relaxed"
            >
              {code}
            </pre>
          );
        }

        // Regular text — process line by line
        const lines = segment.split('\n');
        return (
          <div key={si}>
            {lines.map((line, li) => {
              // H3
              if (line.startsWith('### ')) {
                return (
                  <h3 key={li} className="font-semibold text-sm mt-3 mb-0.5 text-gray-900">
                    {formatInline(line.slice(4))}
                  </h3>
                );
              }
              // H2
              if (line.startsWith('## ')) {
                return (
                  <h2 key={li} className="font-semibold text-sm mt-4 mb-1 text-gray-900">
                    {formatInline(line.slice(3))}
                  </h2>
                );
              }
              // H1
              if (line.startsWith('# ')) {
                return (
                  <h1 key={li} className="font-bold text-base mt-4 mb-1 text-gray-900">
                    {formatInline(line.slice(2))}
                  </h1>
                );
              }
              // Horizontal rule
              if (/^-{3,}$/.test(line.trim()) || /^={3,}$/.test(line.trim())) {
                return <hr key={li} className="my-2 border-gray-200" />;
              }
              // Table separator row — skip rendering
              if (/^\|[\s\-:|]+\|/.test(line.trim())) {
                return null;
              }
              // Table data row — monospace so columns stay legible
              if (line.trim().startsWith('|')) {
                return (
                  <code key={li} className="block text-xs font-mono text-gray-700 leading-5 whitespace-pre">
                    {line}
                  </code>
                );
              }
              // Bullet list item
              if (/^[\-\*] /.test(line)) {
                return (
                  <div key={li} className="flex gap-2 my-0.5 pl-1">
                    <span className="text-gray-400 flex-shrink-0 mt-[3px] text-xs leading-5">•</span>
                    <span className="text-sm leading-relaxed">{formatInline(line.slice(2))}</span>
                  </div>
                );
              }
              // Numbered list item
              const numMatch = line.match(/^(\d+)\.\s(.+)/);
              if (numMatch) {
                return (
                  <div key={li} className="flex gap-2 my-0.5 pl-1">
                    <span className="text-blue-600 font-medium flex-shrink-0 text-xs mt-[3px] min-w-[1.25rem] leading-5">
                      {numMatch[1]}.
                    </span>
                    <span className="text-sm leading-relaxed">{formatInline(numMatch[2])}</span>
                  </div>
                );
              }
              // Empty line → small gap
              if (line.trim() === '') {
                return <div key={li} className="h-1.5" />;
              }
              // Regular paragraph
              return (
                <p key={li} className="text-sm leading-relaxed">
                  {formatInline(line)}
                </p>
              );
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
        <span
          key={delay}
          className="w-2 h-2 bg-gray-300 rounded-full animate-bounce"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </div>
  );
}

// ─── Send icon ────────────────────────────────────────────────────────────

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
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Scroll to bottom whenever messages update
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed || isStreaming) return;

      const userMessage: Message = { role: 'user', content: trimmed };
      const updatedMessages = [...messages, userMessage];

      // Optimistically add user message + empty assistant placeholder
      setMessages([...updatedMessages, { role: 'assistant', content: '' }]);
      setInput('');
      setIsStreaming(true);

      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }

      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: updatedMessages }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`API returned ${response.status}`);
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let accumulated = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          accumulated += decoder.decode(value, { stream: true });

          // Capture accumulated in a stable closure variable for the setter
          const snapshot = accumulated;
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: 'assistant', content: snapshot };
            return updated;
          });
        }
      } catch (err: unknown) {
        // Don't show an error if the user manually aborted
        if (err instanceof Error && err.name === 'AbortError') return;

        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: 'assistant',
            content: 'Something went wrong — please try again.',
          };
          return updated;
        });
      } finally {
        setIsStreaming(false);
        abortControllerRef.current = null;
      }
    },
    [messages, isStreaming]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    // Auto-resize up to 200px
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
  };

  const handleNewChat = () => {
    abortControllerRef.current?.abort();
    setMessages([]);
    setInput('');
    setIsStreaming(false);
  };

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
        </div>

        {messages.length > 0 && (
          <button
            onClick={handleNewChat}
            className="text-slate-400 hover:text-white text-sm transition-colors px-3 py-1.5 rounded-lg hover:bg-slate-800"
          >
            New chat
          </button>
        )}
      </header>

      {/* ── Message area ──────────────────────────────────────────────── */}
      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto">

        {/* Empty state */}
        {messages.length === 0 && (
          <div className="max-w-2xl mx-auto px-4 py-12">
            <div className="text-center mb-8">
              <div className="w-16 h-16 bg-slate-900 rounded-2xl flex items-center justify-center text-3xl font-bold text-white mx-auto mb-4 select-none">
                B
              </div>
              <h2 className="text-2xl font-semibold text-gray-900 mb-2">BDS Sales Copilot</h2>
              <p className="text-gray-500 text-base leading-relaxed max-w-md mx-auto">
                Product recommendations, email drafts, client intel, and UK playbooks —
                everything you need during or between client calls.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {QUICK_PROMPTS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => sendMessage(p.prompt)}
                  className="text-left p-4 bg-white rounded-xl border border-gray-200 hover:border-blue-400 hover:shadow-sm transition-all group cursor-pointer"
                >
                  <div className="text-xl mb-1.5">{p.icon}</div>
                  <div className="font-medium text-gray-900 text-sm group-hover:text-blue-700 transition-colors">
                    {p.label}
                  </div>
                  <div className="text-gray-400 text-xs mt-0.5">{p.description}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Message list */}
        {messages.length > 0 && (
          <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex items-start gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {/* Assistant avatar */}
                {msg.role === 'assistant' && (
                  <div className="w-7 h-7 bg-slate-900 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0 mt-0.5 select-none">
                    B
                  </div>
                )}

                {/* Bubble */}
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

                {/* User avatar */}
                {msg.role === 'user' && (
                  <div className="w-7 h-7 bg-blue-100 rounded-full flex items-center justify-center text-blue-600 text-xs font-bold flex-shrink-0 mt-0.5 select-none">
                    R
                  </div>
                )}
              </div>
            ))}

            {/* Scroll anchor */}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* ── Input area ────────────────────────────────────────────────── */}
      <div className="border-t border-gray-200 bg-white px-4 py-4 flex-shrink-0">
        <div className="max-w-3xl mx-auto">
          <div className="flex gap-3 items-end">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything — products, email drafts, client prep, UK questions…"
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
    </div>
  );
}
