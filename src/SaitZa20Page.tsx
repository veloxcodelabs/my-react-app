import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { isGeneratorHost, MAIN_SITE_URL } from "./generatorHost";

const STORAGE_KEY = "sait-za-20-used-emails";
const PREVIEW_KEY = "sait-za-20-preview";
const MAX_PROMPT = 2000;
const MAX_PHOTOS = 3;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_EDGE = 1600;

type Status = "idle" | "sending" | "error";
type Choice = "buy" | "design";
type PhotoRole = "style" | "embed";

interface Photo {
  id: string;
  name: string;
  mime: string;
  dataUrl: string;
  role: PhotoRole;
}

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

function applyPhotoTokens(html: string, photos: Photo[]) {
  let next = html;
  photos
    .filter((photo) => photo.role === "embed")
    .forEach((photo, index) => {
      next = next.split(`{{PHOTO_${index + 1}}}`).join(photo.dataUrl);
    });
  return next;
}

async function compressPhoto(file: File): Promise<Photo> {
  const mime = file.type === "image/jpg" ? "image/jpeg" : file.type;
  if (mime !== "image/jpeg" && mime !== "image/png" && mime !== "image/webp") {
    throw new Error("Само JPG, PNG или WebP.");
  }
  if (file.size > MAX_PHOTO_BYTES) {
    throw new Error("Всяка снимка трябва да е до 5 MB.");
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Не успяхме да обработим снимката.");
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const outputMime = canvas.toDataURL("image/webp").startsWith("data:image/webp")
    ? "image/webp"
    : "image/jpeg";
  let quality = 0.82;
  let dataUrl = canvas.toDataURL(outputMime, quality);
  while (dataUrl.length > 800000 && quality > 0.45) {
    quality -= 0.12;
    dataUrl = canvas.toDataURL(outputMime, quality);
  }
  if (dataUrl.length > 1000000) {
    throw new Error("Снимката е твърде голяма след компресия. Качи по-малък файл.");
  }
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name,
    mime: outputMime,
    dataUrl,
    role: "embed",
  };
}

function liveDocument(raw: string) {
  const trimmed = raw.trim();
  if (/<html[\s>]/i.test(trimmed)) return trimmed;
  return `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${trimmed}</body></html>`;
}

const STRIPE_BUY_URL = "https://buy.stripe.com/9B628r8DzdPtecec3jcQU02";

function choiceLabel(choice: Choice) {
  return choice === "buy" ? "Купувам за €20" : "Искам още дизайн";
}

function stripeBuyUrl(email: string | undefined) {
  const url = new URL(STRIPE_BUY_URL);
  const trimmed = email?.trim();
  if (trimmed) url.searchParams.set("prefilled_email", trimmed);
  return url.toString();
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
  const [photos, setPhotos] = useState<Photo[]>([]);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  async function addPhotos(fileList: FileList | null) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (photos.length >= MAX_PHOTOS) {
      setStatus("error");
      setMessage("Можеш да качиш до 3 снимки.");
      return;
    }
    const room = MAX_PHOTOS - photos.length;
    const accepted = files.slice(0, room);
    if (files.length > room) {
      setStatus("error");
      setMessage("Можеш да качиш до 3 снимки.");
    } else {
      setMessage("");
      setStatus("idle");
    }
    try {
      const next = [];
      for (const file of accepted) next.push(await compressPhoto(file));
      setPhotos((current) => [...current, ...next].slice(0, MAX_PHOTOS));
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Не успяхме да обработим снимката.");
    }
  }

  function setPhotoRole(id: string, role: PhotoRole) {
    setPhotos((current) => current.map((photo) => (photo.id === id ? { ...photo, role } : photo)));
  }

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
    const payload = JSON.stringify({
      email: nextEmail,
      business: nextBusiness,
      prompt: nextPrompt,
      images: photos.map((photo) => ({ role: photo.role, mime: photo.mime, data: photo.dataUrl })),
    });
    if (payload.length > 3800000) {
      setStatus("error");
      setMessage("Снимките заедно са твърде големи. Махни една или качи по-малки.");
      return;
    }

    setStatus("sending");
    setMessage("");
    const chosenPhotos = photos;

    try {
      const response = await fetch("/api/sait-za-20", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
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
              setPreview({
                email: nextEmail,
                business: nextBusiness,
                html: applyPhotoTokens(liveDocument(raw), chosenPhotos),
              });
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
        {isGeneratorHost(window.location.hostname) ? (
          <a href={MAIN_SITE_URL} style={backLinkStyle}>
            ← Начало
          </a>
        ) : (
          <Link to="/" style={backLinkStyle}>
            ← Начало
          </Link>
        )}
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
              <a
                href={stripeBuyUrl(preview.email)}
                target="_blank"
                rel="noopener noreferrer"
                style={choice === "buy" ? actionOnStyle : actionStyle}
                onClick={() => setChoice("buy")}
              >
                Купувам за €20
              </a>
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

            <div style={photoBlockStyle}>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                hidden
                onChange={(event) => {
                  void addPhotos(event.target.files);
                  event.target.value = "";
                }}
              />
              <button type="button" style={uploadButtonStyle} onClick={() => fileRef.current?.click()}>
                Качи снимки
              </button>
              <p style={hintStyle}>До 3 снимки · JPG, PNG или WebP · до 5 MB всяка</p>
              {photos.map((photo) => (
                <div key={photo.id} style={photoRowStyle}>
                  <img src={photo.dataUrl} alt="" style={thumbStyle} />
                  <div style={photoMetaStyle}>
                    <div style={roleRowStyle}>
                      <button
                        type="button"
                        aria-pressed={photo.role === "style"}
                        style={photo.role === "style" ? roleOnStyle : roleOffStyle}
                        onClick={() => setPhotoRole(photo.id, "style")}
                      >
                        Пример за стил
                      </button>
                      <button
                        type="button"
                        aria-pressed={photo.role === "embed"}
                        style={photo.role === "embed" ? roleOnStyle : roleOffStyle}
                        onClick={() => setPhotoRole(photo.id, "embed")}
                      >
                        Сложи в сайта
                      </button>
                    </div>
                    <button
                      type="button"
                      style={removeStyle}
                      onClick={() => setPhotos((current) => current.filter((item) => item.id !== photo.id))}
                    >
                      Махни
                    </button>
                  </div>
                </div>
              ))}
            </div>

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

const photoBlockStyle: React.CSSProperties = {
  marginTop: 8,
};

const uploadButtonStyle: React.CSSProperties = {
  width: "100%",
  padding: "12px 16px",
  borderRadius: 10,
  border: "2px solid #0070f3",
  background: "#fff",
  color: "#0070f3",
  fontSize: 16,
  fontWeight: 700,
  fontFamily: "inherit",
  cursor: "pointer",
};

const photoRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 12,
  alignItems: "center",
  marginTop: 12,
};

const thumbStyle: React.CSSProperties = {
  width: 72,
  height: 72,
  objectFit: "cover",
  borderRadius: 12,
  background: "#fff",
  flex: "0 0 auto",
};

const photoMetaStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
};

const roleRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
};

const roleOffStyle: React.CSSProperties = {
  border: "1px solid #d5d5d5",
  background: "#fff",
  color: "#333",
  borderRadius: 999,
  padding: "6px 10px",
  fontSize: 13,
  fontWeight: 700,
  fontFamily: "inherit",
  cursor: "pointer",
};

const roleOnStyle: React.CSSProperties = {
  ...roleOffStyle,
  borderColor: "#0070f3",
  background: "#0070f3",
  color: "#fff",
};

const removeStyle: React.CSSProperties = {
  marginTop: 6,
  border: "none",
  background: "transparent",
  color: "#9f1239",
  padding: 0,
  fontSize: 13,
  fontWeight: 700,
  fontFamily: "inherit",
  cursor: "pointer",
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
