
import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Configuration IA ────────────────────────────────────────────────────
// Clé API Anthropic : à définir comme variable d'environnement
// ANTHROPIC_API_KEY sur ta plateforme d'hébergement (ne jamais l'écrire en dur ici).
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = "claude-sonnet-5";

interface ChatScenario {
  id: string;
  title: string;
  titleDe: string;
  level: string;
  context: string;
  initialMessage: string;
  vocabulary: { de: string; fr: string }[];
  tips: string[];
}

interface ChatMessage {
  id: number;
  text: string;
  sender: "ai" | "user";
}

// ── Personnalité du tuteur IA ───────────────────────────────────────────
// Ce prompt système façonne le "caractère" de l'IA : un tuteur allemand
// bienveillant, chaleureux et naturel plutôt qu'un robot qui récite des phrases.
function buildSystemPrompt(scenario: ChatScenario): string {
  const vocabList = scenario.vocabulary.map(v => `${v.de} (${v.fr})`).join(", ");

  return `Tu es Klaus, un tuteur d'allemand virtuel, chaleureux, patient et plein d'humour. Tu incarnes un(e) partenaire de conversation dans un jeu de rôle pour un(e) apprenant(e) francophone de niveau ${scenario.level} (CECRL).

## Ta personnalité
- Tu es bienveillant(e), encourageant(e) et jamais condescendant(e). Tu célèbres les progrès, même petits.
- Tu parles comme un humain chaleureux, pas comme un manuel scolaire : phrases naturelles, spontanées, parfois une touche d'humour léger.
- Tu utilises des emojis avec parcimonie et à bon escient (1 à 3 par message) pour donner du ton : 😊 🎉 🤔 👍 ☕ — jamais en excès.
- Tu relances systématiquement la conversation avec une question ouverte pour donner envie de continuer à écrire, sauf si le scénario touche naturellement à sa fin.
- Tu varies tes formulations : évite de répéter les mêmes structures de phrase d'un message à l'autre.

## Le scénario de jeu de rôle
- Titre : "${scenario.title}" (${scenario.titleDe})
- Contexte : ${scenario.context}
- Ton premier message dans cette conversation était : "${scenario.initialMessage}"
- Reste fidèle à ce personnage et à ce contexte pendant tout l'échange.
- Vocabulaire clé à intégrer naturellement quand c'est pertinent : ${vocabList}

## Pédagogie
- Réponds principalement EN ALLEMAND, avec un niveau de langue adapté au niveau ${scenario.level} (vocabulaire, longueur de phrase, complexité grammaticale).
- Si l'apprenant(e) fait une erreur de grammaire ou de vocabulaire, ne l'ignore pas mais ne casse pas non plus le rythme : glisse une reformulation correcte et naturelle dans ta réponse, avec bienveillance, sans la lister comme une correction scolaire (ex. "Ah, du meinst wahrscheinlich... 😊").
- Si l'apprenant(e) écrit en français ou semble bloqué(e), aide-le/la gentiment avec une courte traduction ou un indice entre parenthèses, puis reviens à l'allemand.
- Garde tes réponses courtes et vivantes : 1 à 4 phrases maximum, adaptées à un échange de chat, jamais un pavé de texte.
- Ne sors jamais de ton rôle pour expliquer que tu es une IA : tu es Klaus, un partenaire de conversation dans ce scénario.`;
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  app.use(express.json());

  // ── Endpoint de chat IA en streaming ──────────────────────────────────
  // Le client envoie le scénario + l'historique des messages, et reçoit
  // la réponse de l'IA en flux (Server-Sent Events), mot par mot.
  app.post("/api/chat/stream", async (req, res) => {
    try {
      const { scenario, messages } = req.body as {
        scenario: ChatScenario;
        messages: ChatMessage[];
      };

      if (!scenario || !Array.isArray(messages)) {
        res.status(400).json({ error: "Requête invalide." });
        return;
      }

      if (!ANTHROPIC_API_KEY) {
        res.status(500).json({
          error:
            "ANTHROPIC_API_KEY n'est pas configurée sur le serveur. Ajoute cette variable d'environnement sur ta plateforme d'hébergement.",
        });
        return;
      }

      // On retire le tout premier message si c'est le message d'accueil de l'IA
      // (il est déjà décrit dans le system prompt), pour que la conversation
      // envoyée à l'API commence bien par un message "user".
      const trimmed =
        messages.length > 0 && messages[0].sender === "ai" ? messages.slice(1) : messages;

      const anthropicMessages = trimmed.map(m => ({
        role: m.sender === "user" ? ("user" as const) : ("assistant" as const),
        content: m.text,
      }));

      if (anthropicMessages.length === 0) {
        res.status(400).json({ error: "Aucun message à envoyer." });
        return;
      }

      const upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 400,
          system: buildSystemPrompt(scenario),
          messages: anthropicMessages,
          stream: true,
        }),
      });

      if (!upstream.ok || !upstream.body) {
        const errText = await upstream.text().catch(() => "");
        res.status(upstream.status).json({
          error: `Erreur de l'API Anthropic (${upstream.status}): ${errText}`,
        });
        return;
      }

      // Préparation de la réponse en Server-Sent Events vers le client
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";

        for (const chunk of chunks) {
          const dataLine = chunk.split("\n").find(line => line.startsWith("data:"));
          if (!dataLine) continue;

          const jsonStr = dataLine.slice(5).trim();
          if (!jsonStr) continue;

          try {
            const event = JSON.parse(jsonStr);
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
              res.write(`data: ${JSON.stringify({ delta: event.delta.text })}\n\n`);
            }
          } catch {
            // Ignore les lignes non-JSON (keep-alive, etc.)
          }
        }
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (err) {
      console.error("Erreur /api/chat/stream:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Erreur interne du serveur." });
      } else {
        res.end();
      }
    }
  });

  // Serve static files from dist/public in production
  const staticPath =
    process.env.NODE_ENV === "production"
      ? path.resolve(__dirname, "public")
      : path.resolve(__dirname, "..", "dist", "public");

  app.use(express.static(staticPath));

  // Handle client-side routing - serve index.html for all routes
  app.get("*", (_req, res) => {
    res.sendFile(path.join(staticPath, "index.html"));
  });

  const port = process.env.PORT || 3000;

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
