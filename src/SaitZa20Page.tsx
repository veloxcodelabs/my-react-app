import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";

const STORAGE_KEY = "sait-za-20-used-emails";
const THANKS_KEY = "sait-za-20-thanks";

type Status = "idle" | "sending" | "sent" | "error";

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

export default function SaitZa20Page() {
  const [email, setEmail] = useState("");
  const [business, setBusiness] = useState("");
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [submittedEmail, setSubmittedEmail] = useState("");

  useEffect(() => {
    const previousTitle = document.title;
    const previousLang = document.documentElement.lang;
    document.title = "Сайт за €20 — Marti Tony Studio";
    document.documentElement.lang = "bg";
    const saved = sessionStorage.getItem(THANKS_KEY);
    if (saved) {
      setSubmittedEmail(saved);
      setStatus("sent");
    }
    return () => {
      document.title = previousTitle;
      document.documentElement.lang = previousLang;
    };
  }, []);

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
      const data = await response.json().catch(() => ({}));
      if (response.status === 409 || data.error === "duplicate") {
        rememberEmail(nextEmail);
        setStatus("error");
        setMessage(data.message || "Този имейл вече е използван за безплатния преглед.");
        return;
      }
      if (!response.ok || data.ok === false) {
        setStatus("error");
        setMessage(data.message || "Нещо се обърка. Опитай отново след малко.");
        return;
      }
      rememberEmail(nextEmail);
      sessionStorage.setItem(THANKS_KEY, nextEmail);
      setSubmittedEmail(nextEmail);
      setStatus("sent");
    } catch {
      setStatus("error");
      setMessage("Няма връзка. Провери интернета и опитай отново.");
    }
  }

  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <Link to="/" style={backLinkStyle}>
          ← Начало
        </Link>
      </header>
      <main style={mainStyle}>
        <p style={eyebrowStyle}>Marti Tony Studio</p>
        <h1 style={titleStyle}>Сайт за €20 + безплатен домейн и хостинг за 12 месеца</h1>
        <p style={leadStyle}>
          Опиши какъв сайт искаш — какъв е бизнесът, какъв стил търсиш и кои секции да има.
          Правим един безплатен преглед и го изпращаме на имейла ти. Ако ти хареса, купуваш го
          за €20. Ако искаш промени по дизайна, пишеш какво да доработим.
        </p>
        <ul style={listStyle}>
          <li>Един безплатен преглед на всеки имейл</li>
          <li>Подготвяме прегледа и го пращаме на пощата ти</li>
          <li>Харесва ти — вземаш го за €20, с домейн и хостинг за 12 месеца</li>
          <li>Искаш друг вид — казваш и доработваме дизайна</li>
        </ul>

        {status === "sent" ? (
          <section style={thanksStyle} aria-live="polite">
            <p style={thanksMarkStyle}>Готово</p>
            <h2 style={thanksTitleStyle}>Заявката е приета</h2>
            <p style={thanksTextStyle}>
              Ще подготвим безплатния преглед и ще го изпратим на <strong>{submittedEmail}</strong>.
              Погледни и папката за спам. Ако ти хареса, можеш да го купиш за €20. Ако искаш
              промени по дизайна, отговори на писмото.
            </p>
            <Link to="/" style={secondaryLinkStyle}>
              Обратно към началото
            </Link>
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
              maxLength={5000}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Например: семейна пекарна в Пловдив, топъл и семпъл стил, секции Начало, Меню, За нас и Контакти."
              style={textareaStyle}
            />

            {status === "error" && message ? (
              <p role="alert" style={errorStyle}>
                {message}
              </p>
            ) : null}

            <button type="submit" style={buttonStyle} disabled={status === "sending"}>
              {status === "sending" ? "Изпращаме…" : "Изпрати заявката"}
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
  margin: "0 0 16px",
  fontSize: 16,
  lineHeight: 1.55,
};

const listStyle: React.CSSProperties = {
  margin: "0 0 28px",
  paddingLeft: 18,
  fontSize: 15,
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
  minHeight: 150,
  resize: "vertical",
  lineHeight: 1.45,
};

const buttonStyle: React.CSSProperties = {
  marginTop: 10,
  width: "100%",
  padding: "12px 16px",
  border: "none",
  borderRadius: 10,
  background: "#0070f3",
  color: "#fff",
  fontSize: 16,
  fontWeight: 700,
  fontFamily: "inherit",
  cursor: "pointer",
};

const errorStyle: React.CSSProperties = {
  margin: "8px 0 0",
  color: "#9f1239",
  fontSize: 14,
  lineHeight: 1.4,
};

const thanksStyle: React.CSSProperties = {
  background: "#f5f5f5",
  borderRadius: 20,
  padding: "28px 20px",
  textAlign: "center",
  boxShadow:
    "0 0 1px hsl(0deg 0% 0% / 0.075), 0 0 2px hsl(0deg 0% 0% / 0.075), 0 0 8px hsl(0deg 0% 0% / 0.05)",
};

const thanksMarkStyle: React.CSSProperties = {
  margin: 0,
  color: "#0070f3",
  fontSize: 13,
  fontWeight: 800,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
};

const thanksTitleStyle: React.CSSProperties = {
  margin: "8px 0 12px",
  fontSize: 28,
  lineHeight: 1.2,
};

const thanksTextStyle: React.CSSProperties = {
  margin: "0 auto 18px",
  maxWidth: 420,
  fontSize: 16,
  lineHeight: 1.55,
};

const secondaryLinkStyle: React.CSSProperties = {
  color: "#0070f3",
  fontWeight: 700,
};
