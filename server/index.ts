/*
 * AI Practice Page — Akademisch Futuristisch v2
 * Conversation IA en direct (streaming) avec un tuteur allemand chaleureux
 * + effet machine à écrire (texte affiché au fil de l'eau)
 * + bouton audio pour écouter la prononciation allemande
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { GraduationCap, Send, RotateCcw, BookOpen, Lightbulb, ArrowLeft, Sparkles, Zap, Volume2, VolumeX, AlertTriangle } from 'lucide-react';
import { Link } from 'wouter';
import Layout from '@/components/Layout';
import { AI_SCENARIOS, LEVEL_COLORS, type LevelId, type AIScenario } from '@/contexts/LearnContext';

interface Message {
  id: number;
  text: string;
  sender: 'ai' | 'user';
  timestamp: Date;
}

// ── Lecture audio (Web Speech API — gratuite, intégrée au navigateur) ────
let cachedGermanVoice: SpeechSynthesisVoice | null = null;
let voicesReady = false;

function pickGermanVoice(): SpeechSynthesisVoice | null {
  if (typeof window === 'undefined' || !window.speechSynthesis) return null;
  const voices = window.speechSynthesis.getVoices();
  if (voices.length > 0) voicesReady = true;
  const de = voices.find(v => v.lang?.toLowerCase().startsWith('de'));
  cachedGermanVoice = de || null;
  return cachedGermanVoice;
}

function speakGerman(text: string, onStart?: () => void, onEnd?: () => void) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;

  window.speechSynthesis.cancel(); // stoppe toute lecture en cours

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'de-DE';
  utterance.rate = 0.95;
  const voice = voicesReady ? cachedGermanVoice : pickGermanVoice();
  if (voice) utterance.voice = voice;

  utterance.onstart = () => onStart?.();
  utterance.onend = () => onEnd?.();
  utterance.onerror = () => onEnd?.();

  window.speechSynthesis.speak(utterance);
}

export default function IA() {
  const [selectedScenario, setSelectedScenario] = useState<AIScenario | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false); // "..." avant le premier mot
  const [isStreaming, setIsStreaming] = useState(false); // texte en train d'arriver
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping, scrollToBottom]);

  // Précharge les voix disponibles (certains navigateurs les chargent en asynchrone)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    pickGermanVoice();
    window.speechSynthesis.onvoiceschanged = () => pickGermanVoice();
    return () => {
      window.speechSynthesis.cancel();
    };
  }, []);

  const startScenario = useCallback((scenario: AIScenario) => {
    abortRef.current?.abort();
    setSelectedScenario(scenario);
    setMessages([{
      id: Date.now(),
      text: scenario.initialMessage,
      sender: 'ai',
      timestamp: new Date(),
    }]);
    setInput('');
    setErrorMsg(null);
    setIsTyping(false);
    setIsStreaming(false);
  }, []);

  const sendMessage = useCallback(() => {
    if (!input.trim() || !selectedScenario || isTyping || isStreaming) return;

    const userMsg: Message = {
      id: Date.now(),
      text: input.trim(),
      sender: 'user',
      timestamp: new Date(),
    };

    const historyForApi = [...messages, userMsg];
    setMessages(historyForApi);
    setInput('');
    setErrorMsg(null);
    setIsTyping(true);

    const aiMsgId = Date.now() + 1;
    const controller = new AbortController();
    abortRef.current = controller;

    (async () => {
      try {
        const response = await fetch('/api/chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            scenario: {
              id: selectedScenario.id,
              title: selectedScenario.title,
              titleDe: selectedScenario.titleDe,
              level: selectedScenario.level,
              context: selectedScenario.context,
              initialMessage: selectedScenario.initialMessage,
              vocabulary: selectedScenario.vocabulary,
              tips: selectedScenario.tips,
            },
            messages: historyForApi.map(m => ({ id: m.id, text: m.text, sender: m.sender })),
          }),
        });

        if (!response.ok || !response.body) {
          const errData = await response.json().catch(() => null);
          throw new Error(errData?.error || `Erreur serveur (${response.status})`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let started = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() ?? '';

          for (const chunk of chunks) {
            const dataLine = chunk.split('\n').find(line => line.startsWith('data:'));
            if (!dataLine) continue;
            const jsonStr = dataLine.slice(5).trim();
            if (!jsonStr) continue;

            let event: { delta?: string; done?: boolean; error?: string };
            try {
              event = JSON.parse(jsonStr);
            } catch {
              continue;
            }

            if (event.delta) {
              if (!started) {
                // Premier mot reçu : on affiche la bulle et on passe en mode streaming
                started = true;
                setIsTyping(false);
                setIsStreaming(true);
                setMessages(prev => [...prev, {
                  id: aiMsgId,
                  text: event.delta ?? '',
                  sender: 'ai',
                  timestamp: new Date(),
                }]);
              } else {
                // Effet machine à écrire : on ajoute le texte au fur et à mesure
                setMessages(prev => prev.map(m =>
                  m.id === aiMsgId ? { ...m, text: m.text + event.delta } : m
                ));
              }
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        console.error(err);
        setErrorMsg(
          (err as Error).message ||
          "Impossible de contacter le tuteur IA. Vérifie que ANTHROPIC_API_KEY est bien configurée sur le serveur."
        );
      } finally {
        setIsTyping(false);
        setIsStreaming(false);
      }
    })();
  }, [input, selectedScenario, isTyping, isStreaming, messages]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }, [sendMessage]);

  const toggleSpeak = useCallback((msg: Message) => {
    if (speakingId === msg.id) {
      window.speechSynthesis?.cancel();
      setSpeakingId(null);
      return;
    }
    speakGerman(
      msg.text,
      () => setSpeakingId(msg.id),
      () => setSpeakingId(current => (current === msg.id ? null : current))
    );
  }, [speakingId]);

  if (!selectedScenario) {
    return (
      <Layout>
        <div className="container py-8 lg:py-12">
          {/* Header */}
          <div className="mb-8">
            <div className="flex items-center gap-3 mb-1">
              <Zap size={16} className="text-violet-400" />
              <span className="data-label">AI Practice Module</span>
            </div>
            <div className="flex items-center gap-3 mb-2">
              <GraduationCap size={24} className="text-violet-400" />
              <h1 className="font-display text-2xl lg:text-3xl font-bold">Pratique avec l'IA</h1>
            </div>
            <p className="text-muted-foreground">
              Conversationne en allemand avec notre assistant IA dans des scénarios réalistes.
              Chaque scénario est adapté à un niveau spécifique.
            </p>
          </div>

          {/* Scenarios Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {AI_SCENARIOS.map((scenario, i) => (
              <button
                key={scenario.id}
                onClick={() => startScenario(scenario)}
                className={`p-5 rounded-xl border border-border bg-card card-glow-hover transition-all duration-300 group text-left circuit-corner tint-${scenario.level.toLowerCase()}`}
                style={{ animationDelay: `${i * 50}ms` }}
              >
                {/* Data label */}
                <div className="flex items-center justify-between mb-3">
                  <span className="data-label">Szenario {String(i + 1).padStart(2, '0')}</span>
                  <div className={`px-2 py-0.5 rounded-full border text-[10px] font-mono font-bold ${
                    LEVEL_COLORS[scenario.level].bg
                  } ${LEVEL_COLORS[scenario.level].text} ${LEVEL_COLORS[scenario.level].border}`}>
                    {scenario.level}
                  </div>
                </div>

                <h3 className="font-display text-base font-semibold mb-1 group-hover:text-primary transition-colors">
                  {scenario.title}
                </h3>
                <p className="text-xs font-mono text-muted-foreground mb-2">{scenario.titleDe}</p>
                <p className="text-sm text-muted-foreground/80 leading-relaxed">
                  {scenario.description}
                </p>
              </button>
            ))}
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="h-[calc(100vh-3.5rem)] lg:h-screen flex flex-col">
        {/* Chat Header */}
        <div className="flex items-center gap-3 px-4 lg:px-6 py-3 border-b border-border bg-card/50 backdrop-blur-sm status-band">
          <button
            onClick={() => setSelectedScenario(null)}
            className="p-1.5 rounded-lg hover:bg-accent/10 transition-colors"
          >
            <ArrowLeft size={18} className="text-muted-foreground" />
          </button>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="data-label">Aktives Szenario</span>
            </div>
            <h2 className="font-display text-sm font-semibold">{selectedScenario.title}</h2>
            <p className="text-[11px] text-muted-foreground font-mono">{selectedScenario.titleDe}</p>
          </div>
          <div className={`px-2 py-0.5 rounded-full border text-[10px] font-mono font-bold ${
            LEVEL_COLORS[selectedScenario.level].bg
          } ${LEVEL_COLORS[selectedScenario.level].text} ${LEVEL_COLORS[selectedScenario.level].border}`}>
            {selectedScenario.level}
          </div>
        </div>

        {/* Chat Body */}
        <div className="flex-1 flex overflow-hidden">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-4 bg-grid">
            {messages.map(msg => (
              <div
                key={msg.id}
                className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'} animate-in`}
              >
                <div className={`max-w-[80%] lg:max-w-[60%] rounded-2xl px-4 py-3 ${
                  msg.sender === 'user'
                    ? 'bg-primary text-primary-foreground rounded-br-sm'
                    : 'bg-card border border-border rounded-bl-sm'
                }`}>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">
                    {msg.text}
                    {msg.sender === 'ai' && isStreaming && msg.id === messages[messages.length - 1]?.id && (
                      <span className="inline-block w-1.5 h-4 ml-0.5 -mb-0.5 bg-current animate-pulse" />
                    )}
                  </p>
                  {msg.sender === 'ai' && msg.text && (
                    <button
                      onClick={() => toggleSpeak(msg)}
                      className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary transition-colors"
                      title="Écouter la prononciation allemande"
                    >
                      {speakingId === msg.id ? (
                        <>
                          <VolumeX size={13} />
                          <span>Arrêter</span>
                        </>
                      ) : (
                        <>
                          <Volume2 size={13} />
                          <span>Écouter</span>
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
            ))}

            {/* Typing Indicator (avant que le premier mot n'arrive) */}
            {isTyping && (
              <div className="flex justify-start animate-in">
                <div className="bg-card border border-border rounded-2xl rounded-bl-sm px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '0ms' }} />
                    <div className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '150ms' }} />
                    <div className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              </div>
            )}

            {/* Message d'erreur */}
            {errorMsg && (
              <div className="flex justify-start animate-in">
                <div className="max-w-[85%] flex items-start gap-2 bg-destructive/10 border border-destructive/30 rounded-2xl rounded-bl-sm px-4 py-3">
                  <AlertTriangle size={16} className="text-destructive shrink-0 mt-0.5" />
                  <p className="text-xs text-destructive leading-relaxed">{errorMsg}</p>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Sidebar Tips */}
          <div className="hidden xl:block w-72 border-l border-border p-4 overflow-y-auto bg-card/30">
            {/* Vocabulary */}
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <BookOpen size={16} className="text-primary" />
                <span className="data-label">Vocabulaire clé</span>
              </div>
              <div className="space-y-2">
                {selectedScenario.vocabulary.map((word, i) => (
                  <div key={i} className="flex items-center justify-between p-2 rounded-lg bg-muted/50 border border-border/50">
                    <span className="text-sm font-mono text-primary">{word.de}</span>
                    <span className="text-xs text-muted-foreground">{word.fr}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Tips */}
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <Lightbulb size={16} className="text-amber-400" />
                <span className="data-label">Conseils</span>
              </div>
              <div className="space-y-2">
                {selectedScenario.tips.map((tip, i) => (
                  <div key={i} className="text-xs text-muted-foreground p-2 rounded-lg bg-amber-500/5 border border-amber-500/10">
                    {tip}
                  </div>
                ))}
              </div>
            </div>

            {/* Context */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Sparkles size={16} className="text-violet-400" />
                <span className="data-label">Contexte</span>
              </div>
              <p className="text-xs text-muted-foreground p-3 rounded-lg bg-card border border-border">
                {selectedScenario.context}
              </p>
            </div>
          </div>
        </div>

        {/* Chat Input */}
        <div className="px-4 lg:px-6 py-4 border-t border-border bg-card/50 backdrop-blur-sm">
          <div className="flex items-center gap-3 max-w-3xl mx-auto">
            <div className="flex-1 relative">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Écris ta réponse en allemand..."
                className="w-full px-4 py-3 rounded-xl bg-input border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/50 transition-all"
                disabled={isTyping || isStreaming}
              />
            </div>
            <button
              onClick={sendMessage}
              disabled={!input.trim() || isTyping || isStreaming}
              className="p-3 rounded-xl bg-primary text-primary-foreground hover:opacity-90 transition-all active:scale-[0.95] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Send size={18} />
            </button>
            <button
              onClick={() => startScenario(selectedScenario)}
              className="p-3 rounded-xl border border-border hover:bg-accent/10 transition-colors"
              title="Recommencer"
            >
              <RotateCcw size={18} className="text-muted-foreground" />
            </button>
          </div>
        </div>
      </div>
    </Layout>
  );
}
