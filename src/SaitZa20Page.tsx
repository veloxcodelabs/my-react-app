import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

const STORAGE_KEY = "sait-za-20-used-emails";
const PREVIEW_KEY = "sait-za-20-preview";
const MAX_PROMPT = 2000;

type Status = "idle" | "sending" | "error";
type Choice = "buy" | "design";

interface Preview {
  email: string;
  business: string;
  html: string;
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function readUsedEmails(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function rememberEmail(email: string) {
  const used = new Set(readUsedEmails());
  used.add(normalizeEmail(email));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(used)));
}

function readPreview(): Preview | null {
  try {
    const raw = sessionStorage.getItem(PREVIEW_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.html !== "string" || typeof parsed.email !== "string") return null;
    return {
      email: parsed.email,
      business: typeof parsed.business === "string" ? parsed.business : "",
      html: parsed.html,
    };
  } catch {
    return null;
  }
}

function liveDocument(raw: string) {
  const trimmed = raw.trim();
  if (/<html[\s>]/i.test(trimmed)) return trimmed;
  return `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${trimmed}</body></html>`;
}

function choiceLabel(choice: Choice) {
  return choice === "buy" ? "Купувам за €20" : "Искам още дизайн";
}

function mailHref(choice: Choice, preview: Preview, note: string) {
  const label = choiceLabel(choice);
  const body = [
    `Избор: ${label}`,
    `Имейл: ${preview.email}`,
    `Бизнес: ${preview.business || "—"}`,
    "",
    note.trim() || "Без допълнителна бележка.",
  ].join("\n");
  return `mailto:info@martitony.com?subject=${encodeURIComponent(`Сайт за €20 — ${label}`)}&body=${encodeURIComponent(body)}`;
}

export default function SaitZa20Page() {
  const [email, setEmail] = useState("");
  const [business, setBusiness] = useState("");
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [note, setNote] = useState("");
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const previousTitle = document.title;
    const previousLang = document.documentElement.lang;
    document.title = "Сайт за €20 — Marti Tony Studio";
    document.documentElement.lang = "bg";
    const saved = readPreview();
    if (saved) setPreview(saved);
    return () => {
      document.title = previousTitle;
      document.documentElement.lang = previousLang;
    };
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    if (frame.getAttribute("sandbox") === null) frame.setAttribute("sandbox", "");
  }, [preview, choice, note]);

  const mailto = useMemo(
    () => (preview && choice ? mailHref(choice, preview, note) : ""),
    [preview, choice, note]
  );

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextEmail = normalizeEmail(email);
    const nextPrompt = prompt.trim();
    const nextBusiness = business.trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
      setStatus("error");
      setMessage("Въведи валиден имейл.");
      return;
    }
    if (nextBusiness.length > 120) {
      setStatus("error");
      setMessage("Името на бизнеса е твърде дълго.");
      return;
    }
    if (nextPrompt.length < 20) {
      setStatus("error");
      setMessage("Опиши сайта малко по-подробно — бизнес, стил и секции.");
      return;
    }
    if (nextPrompt.length > MAX_PROMPT) {
      setStatus("error");
      setMessage(`Описанието е твърде дълго. Съкрати го до ${MAX_PROMPT} знака.`);
      return;
    }
    if (readUsedEmails().includes(nextEmail)) {
      setStatus("error");
      setMessage("Този имейл вече е използван за безплатния преглед.");
      return;
    }

    setStatus("sending");
    setMessage("");

    try {
      const response = await fetch("/api/sait-za-20", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: nextEmail,
          business: nextBusiness,
          prompt: nextPrompt,
        }),
      });
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream")) {
        const data = await response.json().catch(() => ({}));
        if (response.status === 409 || data.error === "duplicate") {
          rememberEmail(nextEmail);
          setStatus("error");
          setMessage(data.message || "Този имейл вече е използван за безплатния преглед.");
          return;
        }
        setStatus("error");
        setMessage(data.message || "Не успяхме да направим прегледа. Опитай отново след малко.");
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        setStatus("error");
        setMessage("Не успяхме да направим прегледа. Опитай отново след малко.");
        return;
      }
      const decoder = new TextDecoder();
      let buffer = "";
      let raw = "";
      let paintedAt = 0;
      let finished = false;
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";
        for (const block of blocks) {
          const line = block.split("\n").find((item) => item.startsWith("data:"));
          if (!line) continue;
          const event = JSON.parse(line.slice(5).trim());
          if (event.type === "delta" && typeof event.text === "string") {
            raw += event.text;
            const now = Date.now();
            if (now - paintedAt > 120) {
              paintedAt = now;
              setPreview({ email: nextEmail, business: nextBusiness, html: liveDocument(raw) });
            }
          } else if (event.type === "done" && typeof event.html === "string") {
            const nextPreview = { email: nextEmail, business: nextBusiness, html: event.html };
            rememberEmail(nextEmail);
            try {
              sessionStorage.setItem(PREVIEW_KEY, JSON.stringify(nextPreview));
            } catch {
              // The preview still stays on screen if the browser refuses to store it.
            }
            setPreview(nextPreview);
            setChoice(null);
            setNote("");
            setStatus("idle");
            finished = true;
          } else if (event.type === "error") {
            setPreview(null);
            setStatus("error");
            setMessage(event.message || "Не успяхме да направим прегледа. Опитай отново след малко.");
            finished = true;
          }
        }
      }
      if (!finished) {
        setPreview(null);
        setStatus("error");
        setMessage("Не успяхме да направим прегледа. Опитай отново след малко.");
      }
    } catch {
      setStatus("error");
      setMessage("Няма връзка. Провери интернета и опитай отново.");
    }
  }

  return (
    <div style={pageStyle}>
      <style>{`
        @keyframes sait-pulse { 50% { opacity: .45; } }
      `}</style>
      <header style={headerStyle}>
        <Link to="/" style={backLinkStyle}>
          ← Начало
        </Link>
      </header>
      <main style={preview ? wideStyle : mainStyle}>
        <p style={eyebrowStyle}>Marti Tony Studio</p>
        <h1 style={titleStyle}>Сайт за €20 + безплатен домейн и хостинг за 12 месеца</h1>
        <p style={leadStyle}>
          Опиши бизнеса, стила и секциите. След изпращане виждаш безплатен преглед веднага —
          един на имейл. Ако ти хареса, купуваш го за €20. Ако искаш друг дизайн, пишеш какво
          да променим.
        </p>

        {preview ? (
          <section aria-live="polite">
            <div style={previewLabelStyle}>ПРЕГЛЕД</div>
            {status === "sending" ? <p style={hintStyle}>Генерираме прегледа…</p> : null}
            <div style={frameWrapStyle}>
              <iframe
                ref={frameRef}
                title="Преглед на генерирания сайт"
                sandbox=""
                srcDoc={preview.html}
                referrerPolicy="no-referrer"
                style={frameStyle}
              />
              <div aria-hidden="true" style={watermarkStyle}>
                ПРЕГЛЕД
              </div>
            </div>
            <p style={hintStyle}>
              Прегледът е с воден знак и не е готовият сайт. След покупка го правим без знака,
              с домейн и хостинг за 12 месеца.
            </p>
            <div style={actionRowStyle}>
              <button
                type="button"
                style={choice === "buy" ? actionOnStyle : actionStyle}
                onClick={() => setChoice("buy")}
              >
                Купувам за €20
              </button>
              <button
                type="button"
                style={choice === "design" ? actionOnStyle : actionGhostStyle}
                onClick={() => setChoice("design")}
              >
                Искам още дизайн
              </button>
            </div>
            {choice ? (
              <form style={choiceFormStyle} onSubmit={(event) => event.preventDefault()}>
                <p style={choiceTitleStyle}>{choiceLabel(choice)}</p>
                <label style={labelStyle} htmlFor="sait-note">
                  Бележка <span style={optionalStyle}>(по желание)</span>
                </label>
                <textarea
                  id="sait-note"
                  value={note}
                  maxLength={500}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Например: искам по-тъмни цветове или кога да се свържете с мен."
                  style={textareaStyle}
                />
                <a href={mailto} style={actionStyle}>
                  Изпрати до info@martitony.com
                </a>
              </form>
            ) : null}
          </section>
        ) : status === "sending" ? (
          <section style={loadingStyle} aria-live="polite" aria-busy="true">
            <p className="sait-loading" style={loadingTitleStyle}>
              Генерираме прегледа…
            </p>
            <p style={hintStyle}>Обикновено отнема под минута. Не затваряй страницата.</p>
          </section>
        ) : (
          <form onSubmit={handleSubmit} style={formStyle} noValidate>
            <label style={labelStyle} htmlFor="sait-email">
              Имейл
            </label>
            <input
              id="sait-email"
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="ti@example.com"
              style={inputStyle}
            />

            <label style={labelStyle} htmlFor="sait-business">
              Име на бизнеса <span style={optionalStyle}>(по желание)</span>
            </label>
            <input
              id="sait-business"
              name="business"
              type="text"
              autoComplete="organization"
              maxLength={120}
              value={business}
              onChange={(event) => setBusiness(event.target.value)}
              placeholder="Например: Пекарна Зърно"
              style={inputStyle}
            />

            <label style={labelStyle} htmlFor="sait-prompt">
              Какъв сайт искаш
            </label>
            <textarea
              id="sait-prompt"
              name="prompt"
              required
              maxLength={MAX_PROMPT}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Например: семейна пекарна в Пловдив, топъл и семпъл стил, секции Начало, Меню, За нас и Контакти."
              style={textareaStyle}
            />
            <p style={counterStyle}>
              {prompt.trim().length}/{MAX_PROMPT}
            </p>

            {status === "error" && message ? (
              <p role="alert" style={errorStyle}>
                {message}
              </p>
            ) : (
              <p style={hintStyle}>Един безплатен преглед на всеки имейл.</p>
            )}

            <button type="submit" style={actionStyle}>
              Виж безплатния преглед
            </button>
          </form>
        )}
      </main>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "#fff",
  color: "#333",
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
};

const headerStyle: React.CSSProperties = {
  background: "#0070f3",
  padding: "10px 16px",
};

const backLinkStyle: React.CSSProperties = {
  color: "#fff",
  textDecoration: "none",
  fontSize: 14,
  fontWeight: 600,
};

const mainStyle: React.CSSProperties = {
  maxWidth: 560,
  margin: "0 auto",
  padding: "28px 16px 72px",
};

const wideStyle: React.CSSProperties = {
  ...mainStyle,
  maxWidth: 960,
};

const eyebrowStyle: React.CSSProperties = {
  margin: "0 0 8px",
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "#0070f3",
};

const titleStyle: React.CSSProperties = {
  margin: "0 0 16px",
  fontSize: "clamp(24px, 5vw, 34px)",
  lineHeight: 1.2,
  fontWeight: 700,
  color: "#1a1a1a",
};

const leadStyle: React.CSSProperties = {
  margin: "0 0 20px",
  fontSize: 16,
  lineHeight: 1.55,
};

const formStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  background: "#f5f5f5",
  borderRadius: 20,
  padding: 18,
  boxShadow:
    "0 0 1px hsl(0deg 0% 0% / 0.075), 0 0 2px hsl(0deg 0% 0% / 0.075), 0 0 8px hsl(0deg 0% 0% / 0.05)",
};

const labelStyle: React.CSSProperties = {
  marginTop: 8,
  fontSize: 14,
  fontWeight: 700,
};

const optionalStyle: React.CSSProperties = {
  fontWeight: 500,
  color: "#666",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "12px 14px",
  borderRadius: 10,
  border: "1px solid #d5d5d5",
  background: "#fff",
  color: "#222",
  fontSize: 16,
  fontFamily: "inherit",
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  minHeight: 140,
  resize: "vertical",
  lineHeight: 1.45,
};

const counterStyle: React.CSSProperties = {
  margin: 0,
  textAlign: "right",
  color: "#777",
  fontSize: 12,
};

const actionStyle: React.CSSProperties = {
  display: "inline-block",
  boxSizing: "border-box",
  marginTop: 8,
  width: "100%",
  padding: "12px 16px",
  border: "none",
  borderRadius: 10,
  background: "#0070f3",
  color: "#fff",
  fontSize: 16,
  fontWeight: 700,
  fontFamily: "inherit",
  textAlign: "center",
  textDecoration: "none",
  cursor: "pointer",
};

const actionGhostStyle: React.CSSProperties = {
  ...actionStyle,
  background: "#fff",
  color: "#0070f3",
  border: "2px solid #0070f3",
};

const actionOnStyle: React.CSSProperties = {
  ...actionStyle,
  outline: "3px solid rgba(0,112,243,.35)",
};

const errorStyle: React.CSSProperties = {
  margin: "8px 0 0",
  color: "#9f1239",
  fontSize: 14,
  lineHeight: 1.4,
};

const hintStyle: React.CSSProperties = {
  margin: "8px 0 0",
  color: "#555",
  fontSize: 14,
  lineHeight: 1.45,
};

const loadingStyle: React.CSSProperties = {
  background: "#f5f5f5",
  borderRadius: 20,
  padding: "36px 20px",
  textAlign: "center",
};

const loadingTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 22,
  fontWeight: 700,
  animation: "sait-pulse 1.2s ease-in-out infinite",
};

const previewLabelStyle: React.CSSProperties = {
  display: "inline-block",
  marginBottom: 10,
  padding: "6px 12px",
  borderRadius: 999,
  background: "#0070f3",
  color: "#fff",
  fontSize: 13,
  fontWeight: 800,
  letterSpacing: "0.14em",
};

const frameWrapStyle: React.CSSProperties = {
  position: "relative",
  borderRadius: 16,
  overflow: "hidden",
  border: "1px solid #e4e4e4",
  background: "#fff",
};

const frameStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  height: "70vh",
  minHeight: 420,
  border: 0,
  background: "#fff",
};

const watermarkStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
  fontSize: "clamp(42px, 8vw, 84px)",
  fontWeight: 800,
  letterSpacing: "0.14em",
  color: "rgba(0,112,243,.28)",
  transform: "rotate(-18deg)",
  userSelect: "none",
};

const actionRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 10,
  marginTop: 14,
};

const choiceFormStyle: React.CSSProperties = {
  ...formStyle,
  marginTop: 14,
};

const choiceTitleStyle: React.CSSProperties = {
  margin: "4px 0 0",
  fontSize: 18,
  fontWeight: 700,
};
