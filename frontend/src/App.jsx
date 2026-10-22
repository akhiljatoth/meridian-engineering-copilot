import { useState, useEffect } from "react";
import "./App.css";

const API_BASE = "http://localhost:8000/v1";

const EXAMPLES = [
  "How do I create a FastAPI endpoint?",
  "What are the deployment procedures?",
  "Explain the authentication flow",
  "What are the API best practices?",
];

const NAV = [
  { id: "ask", label: "Ask", icon: "◌" },
  { id: "history", label: "History", icon: "◷" },
  { id: "documents", label: "Documents", icon: "▤" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

const DEFAULT_SETTINGS = { topK: 5, saveHistory: true, showMetrics: true };
const MAX_HISTORY = 50;

/* ---------- helpers ---------- */

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

const historyKey = (username) => `meridian_history_${username}`;

function formatTime(ts) {
  return new Date(ts).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function normalizeDoc(d) {
  if (typeof d === "string") return { title: d, source: d };
  return {
    title: d.title || d.name || d.filename || d.source || "Untitled",
    source: d.source || d.path || d.filename || d.id || "",
  };
}

function CodeBlock({ lang, code }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang || "code"}</span>
        <button type="button" className="copy-button" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function AnswerBody({ text }) {
  const parts = String(text ?? "").split(/```(\w*)\n?([\s\S]*?)```/g);
  const nodes = [];
  for (let i = 0; i < parts.length; i += 3) {
    if (parts[i]?.trim()) {
      nodes.push(
        <div className="answer-text" key={`t${i}`}>
          {parts[i].trim()}
        </div>
      );
    }
    if (i + 2 < parts.length) {
      nodes.push(
        <CodeBlock key={`c${i}`} lang={parts[i + 1]} code={parts[i + 2].trim()} />
      );
    }
  }
  return <>{nodes}</>;
}

function Brand() {
  return (
    <div className="brand">
      <div className="brand-mark">M</div>
      <h1>Meridian Copilot</h1>
    </div>
  );
}

export default function App() {
  const [username, setUsername] = useState("engineer");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState(null);
  const [token, setToken] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [view, setView] = useState("ask");
  const [history, setHistory] = useState([]);
  const [settings, setSettings] = useState(() => ({
    ...DEFAULT_SETTINGS,
    ...readJSON("meridian_settings", {}),
  }));
  const [docs, setDocs] = useState({ items: [], fromApi: false });
  const [docsLoading, setDocsLoading] = useState(false);

  /* persist history per user */
  useEffect(() => {
    if (user) writeJSON(historyKey(user.username), history);
  }, [history, user]);

  /* load documents when Documents tab opens */
  useEffect(() => {
    if (view !== "documents" || !token) return;
    let cancelled = false;
    setDocsLoading(true);

    (async () => {
      try {
        const res = await fetch(`${API_BASE}/documents`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 401) {
          if (!cancelled) logout();
          return;
        }
        if (!res.ok) throw new Error("No documents endpoint");
        const data = await res.json();
        const list = Array.isArray(data)
          ? data
          : data.documents || data.items || [];
        if (!cancelled) setDocs({ items: list.map(normalizeDoc), fromApi: true });
      } catch {
        if (!cancelled) setDocs({ items: [], fromApi: false });
      } finally {
        if (!cancelled) setDocsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, token]);

  function updateSetting(key, value) {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      writeJSON("meridian_settings", next);
      return next;
    });
  }

  async function login(event) {
    event.preventDefault();
    if (loggingIn) return;

    setLoggingIn(true);
    setError("");

    try {
      const response = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || "Login failed.");
      }

      setToken(data.access_token);
      setUser({ username: data.username, role: data.role });
      setHistory(readJSON(historyKey(data.username), []));
      setView("ask");
      setPassword("");
      setAnswer(null);
      setQuestion("");
      setError("");
    } catch (err) {
      setError(err.message || "Unable to reach the API.");
    } finally {
      setLoggingIn(false);
    }
  }

  function logout() {
    setToken("");
    setUser(null);
    setHistory([]);
    setDocs({ items: [], fromApi: false });
    setView("ask");
    setPassword("");
    setQuestion("");
    setAnswer(null);
    setError("");
  }

  async function askQuestion(event) {
    event.preventDefault();
    if (!question.trim() || loading || !token) return;

    const asked = question.trim();
    setLoading(true);
    setError("");
    setAnswer(null);

    try {
      const response = await fetch(`${API_BASE}/ask`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          question: asked,
          top_k: settings.topK,
        }),
      });

      const data = await response.json();

      if (response.status === 401) {
        logout();
        throw new Error("Your session expired. Please log in again.");
      }

      if (!response.ok) {
        throw new Error(data.detail || "Request failed.");
      }

      setAnswer(data);

      if (settings.saveHistory) {
        setHistory((prev) =>
          [{ id: Date.now(), question: asked, data }, ...prev].slice(0, MAX_HISTORY)
        );
      }
    } catch (err) {
      setError(err.message || "Unable to reach the API.");
    } finally {
      setLoading(false);
    }
  }

  /* history actions */
  function openHistory(item) {
    setQuestion(item.question);
    setAnswer(item.data);
    setError("");
    setView("ask");
  }

  function deleteHistory(id) {
    setHistory((prev) => prev.filter((h) => h.id !== id));
  }

  function clearHistory() {
    setHistory([]);
  }

  /* documents actions */
  function askAboutDoc(doc) {
    setQuestion(`What does "${doc.title}" cover?`);
    setAnswer(null);
    setError("");
    setView("ask");
  }

  function historyDocs() {
    const seen = new Map();
    history.forEach((h) =>
      (h.data?.citations || []).forEach((c) => {
        if (c.source && !seen.has(c.source)) {
          seen.set(c.source, { title: c.title || c.source, source: c.source });
        }
      })
    );
    return [...seen.values()];
  }

  const displayDocs = docs.fromApi ? docs.items : historyDocs();

  return (
    <main className="app">
      <div className="glow glow-a" />
      <div className="glow glow-b" />

      {!user ? (
        <>
          <header className="header">
            <Brand />
            <nav className="nav">
              <a href="#features">Features</a>
              <a href="#docs">Docs</a>
              <a href="#about">About</a>
              <a href="#contact">Contact</a>
            </nav>
            <span className="status">
              <i />
              API assistant
            </span>
          </header>

          <section className="intro">
            <p className="eyebrow">INTERNAL KNOWLEDGE ASSISTANT</p>
            <h2>
              Ask your <span className="accent">engineering docs.</span>
            </h2>
            <p>Get documentation-grounded answers with source citations.</p>

            <ul className="feature-row" id="features">
              <li>
                <span className="feature-icon">▤</span>
                <div>
                  <strong>Grounded answers</strong>
                  <p>Reliable, factual responses</p>
                </div>
              </li>
              <li>
                <span className="feature-icon">⌕</span>
                <div>
                  <strong>Source citations</strong>
                  <p>See exactly where the answer comes from</p>
                </div>
              </li>
              <li>
                <span className="feature-icon">🔒</span>
                <div>
                  <strong>Secure access</strong>
                  <p>Role-based document permissions</p>
                </div>
              </li>
            </ul>
          </section>

          <section className="workspace login-workspace">
            <form className="question-form" onSubmit={login}>
              <h3>Sign in to Meridian</h3>
              <p className="hint">
                Sign in with your assigned engineering or admin account.
              </p>

              <label htmlFor="username">Username</label>
              <div className="field">
                <span className="field-icon">○</span>
                <input
                  id="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  required
                />
              </div>

              <label htmlFor="password">Password</label>
              <div className="field">
                <span className="field-icon">▣</span>
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  className="field-toggle"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>

              <button className="primary-button" disabled={loggingIn}>
                {loggingIn ? "Signing in..." : "Sign in →"}
              </button>
              {error && <p className="error">{error}</p>}
            </form>

            <section className="answer-panel">
              <div className="empty-state">
                <span className="empty-icon">✳</span>
                <h3>Your knowledge workspace</h3>
                <p>
                  Sign in to ask questions against documents your account is
                  authorized to access.
                </p>
              </div>
            </section>
          </section>
        </>
      ) : (
        <div className="shell">
          <aside className="sidebar">
            <Brand />

            <nav className="side-nav">
              {NAV.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`side-link ${view === item.id ? "active" : ""}`}
                  onClick={() => setView(item.id)}
                >
                  <span>{item.icon}</span> {item.label}
                </button>
              ))}
            </nav>

            <section className="session-bar">
              <div>
                <span className="avatar">
                  {user.username.charAt(0).toUpperCase()}
                </span>
                <div className="who">
                  <strong>{user.username}</strong>
                  <span className="role-label">
                    {user.role === "admin" ? "Admin" : "Engineer"}
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="logout-button"
                onClick={logout}
                disabled={loading}
              >
                Log out
              </button>
            </section>
          </aside>

          <div className="content">
            {/* ================= ASK ================= */}
            {view === "ask" && (
              <>
                <section className="panel ask-panel">
                  <div className="ask-head">
                    <div>
                      <h2>Ask anything</h2>
                      <p>Get documentation-grounded answers with source citations.</p>
                    </div>
                    <span className="online-pill">
                      <i /> Online
                    </span>
                  </div>

                  <form className="question-form" onSubmit={askQuestion}>
                    <label htmlFor="question">Your question</label>
                    <div className="composer">
                      <textarea
                        id="question"
                        value={question}
                        onChange={(event) => setQuestion(event.target.value)}
                        placeholder="How do I create a FastAPI endpoint?"
                        rows={3}
                        required
                      />
                      <div className="composer-foot">
                        <div className="chips">
                          <span>Engineering docs</span>
                          <span>Hybrid search</span>
                          <span>Citations</span>
                          <span>Secure access</span>
                        </div>
                        <button
                          className="send-button"
                          disabled={loading || !question.trim()}
                        >
                          {loading ? "Searching documents..." : "Ask Copilot →"}
                        </button>
                      </div>
                    </div>
                    <p className="hint">
                      Your account determines which documents you can access.
                    </p>
                  </form>

                  <div className="examples">
                    <h3>Example questions</h3>
                    <div className="example-grid">
                      {EXAMPLES.map((text) => (
                        <button
                          key={text}
                          type="button"
                          className="example-card"
                          onClick={() => setQuestion(text)}
                        >
                          <span>{text}</span>
                          <em>↗</em>
                        </button>
                      ))}
                    </div>
                  </div>
                </section>

                <section className="panel answer-panel" aria-live="polite">
                  {!answer && !loading && !error && (
                    <div className="empty-state">
                      <span className="empty-icon">✳</span>
                      <h3>Your answer will appear here</h3>
                      <p>
                        Ask a question to retrieve relevant engineering knowledge.
                      </p>
                    </div>
                  )}

                  {loading && (
                    <p className="message">
                      Searching and generating your answer…
                    </p>
                  )}

                  {error && <p className="error">{error}</p>}

                  {answer && (
                    <div className="answer-grid">
                      <div className="answer-main">
                        <div className="answer-heading">
                          <span className="answer-title">
                            <b className="spark">✳</b> Answer
                          </span>
                          {!answer.abstained && (
                            <span className="grounded">
                              Grounded in documentation
                            </span>
                          )}
                          {answer.abstained && (
                            <span className="abstain">Not sure</span>
                          )}
                          {settings.showMetrics && (
                            <div className="metrics">
                              <span>{answer.latency_ms} ms</span>
                              <span className="live-pill">
                                {answer.cached ? "Cached response" : "Live response"}
                              </span>
                            </div>
                          )}
                        </div>

                        <AnswerBody text={answer.answer} />
                      </div>

                      <aside className="sources">
                        <h3 className="citation-heading">
                          Sources ({answer.citations?.length || 0})
                        </h3>

                        {answer.citations?.length ? (
                          <ul className="citations">
                            {answer.citations.map((citation, index) => (
                              <li key={`${citation.source}-${index}`}>
                                <span className="source-icon">↗</span>
                                <div>
                                  <strong>{citation.title}</strong>
                                  <p>{citation.source}</p>
                                </div>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="hint">
                            No supporting sources were retrieved.
                          </p>
                        )}
                      </aside>
                    </div>
                  )}
                </section>
              </>
            )}

            {/* ================= HISTORY ================= */}
            {view === "history" && (
              <section className="panel view-panel">
                <div className="view-head">
                  <div>
                    <h2>History</h2>
                    <p>Your recent questions, saved on this device.</p>
                  </div>
                  {history.length > 0 && (
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={clearHistory}
                    >
                      Clear all
                    </button>
                  )}
                </div>

                {history.length ? (
                  <ul className="history-list">
                    {history.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          className="history-item"
                          onClick={() => openHistory(item)}
                        >
                          <span className="history-q">{item.question}</span>
                          <span className="history-meta">
                            {formatTime(item.id)} ·{" "}
                            {item.data?.citations?.length || 0} sources
                          </span>
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Delete this question"
                          onClick={() => deleteHistory(item.id)}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="empty-state">
                    <span className="empty-icon">◷</span>
                    <h3>No questions yet</h3>
                    <p>
                      {settings.saveHistory
                        ? "Questions you ask will show up here."
                        : "History saving is off. Turn it on in Settings."}
                    </p>
                  </div>
                )}
              </section>
            )}

            {/* ================= DOCUMENTS ================= */}
            {view === "documents" && (
              <section className="panel view-panel">
                <div className="view-head">
                  <div>
                    <h2>Documents</h2>
                    <p>
                      {docs.fromApi
                        ? "Documents your account can access."
                        : "Sources referenced in your answers."}
                    </p>
                  </div>
                </div>

                {docsLoading ? (
                  <p className="message">Loading documents…</p>
                ) : displayDocs.length ? (
                  <div className="doc-grid">
                    {displayDocs.map((doc, index) => (
                      <div className="doc-card" key={`${doc.source}-${index}`}>
                        <div className="doc-top">
                          <span className="source-icon">▤</span>
                          <div>
                            <strong>{doc.title}</strong>
                            <p>{doc.source}</p>
                          </div>
                        </div>
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => askAboutDoc(doc)}
                        >
                          Ask about this
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">
                    <span className="empty-icon">▤</span>
                    <h3>No documents yet</h3>
                    <p>
                      Ask a few questions and the sources used will be listed
                      here.
                    </p>
                  </div>
                )}
              </section>
            )}

            {/* ================= SETTINGS ================= */}
            {view === "settings" && (
              <section className="panel view-panel">
                <div className="view-head">
                  <div>
                    <h2>Settings</h2>
                    <p>Preferences are saved on this device.</p>
                  </div>
                </div>

                <div className="settings-list">
                  <div className="setting-row">
                    <div>
                      <strong>Sources per answer</strong>
                      <p>How many document chunks are retrieved for each question.</p>
                    </div>
                    <select
                      value={settings.topK}
                      onChange={(e) => updateSetting("topK", Number(e.target.value))}
                    >
                      {[3, 5, 8, 10].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="setting-row">
                    <div>
                      <strong>Save history</strong>
                      <p>Keep your last {MAX_HISTORY} questions and answers.</p>
                    </div>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={settings.saveHistory}
                        onChange={(e) =>
                          updateSetting("saveHistory", e.target.checked)
                        }
                      />
                      <span />
                    </label>
                  </div>

                  <div className="setting-row">
                    <div>
                      <strong>Show response details</strong>
                      <p>Display latency and live/cached status on answers.</p>
                    </div>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={settings.showMetrics}
                        onChange={(e) =>
                          updateSetting("showMetrics", e.target.checked)
                        }
                      />
                      <span />
                    </label>
                  </div>

                  <div className="setting-row">
                    <div>
                      <strong>Clear history</strong>
                      <p>{history.length} saved question{history.length === 1 ? "" : "s"}.</p>
                    </div>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={clearHistory}
                      disabled={!history.length}
                    >
                      Clear
                    </button>
                  </div>

                  <div className="setting-row">
                    <div>
                      <strong>Account</strong>
                      <p>
                        {user.username} ·{" "}
                        {user.role === "admin" ? "Admin" : "Engineer"}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={logout}
                      disabled={loading}
                    >
                      Log out
                    </button>
                  </div>
                </div>
              </section>
            )}
          </div>
        </div>
      )}

      <footer>
        MERIDIAN ENGINEERING COPILOT · RAG KNOWLEDGE SEARCH
      </footer>
    </main>
  );
}