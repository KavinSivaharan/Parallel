"use client";

import {
  AlertTriangle,
  Box,
  Check,
  ChevronDown,
  CircleDot,
  Clock3,
  Code2,
  GitBranch,
  Pause,
  Play,
  Radio,
  Search,
  TerminalSquare,
  Users,
} from "lucide-react";
import { useMemo, useState } from "react";

type Panel = "timeline" | "artifacts";

const events = [
  { time: "14:32:08", kind: "system", text: "Execution resumed from checkpoint cp_8f2a", detail: "Driver: Kavin" },
  { time: "14:32:11", kind: "agent", text: "Inspecting authentication boundaries", detail: "Codex · analysis" },
  { time: "14:32:16", kind: "tool", text: "Read 8 files", detail: "src/auth/** · 42.8 KB" },
  { time: "14:32:22", kind: "agent", text: "Found a race between session refresh and token rotation.", detail: "Codex · commentary" },
  { time: "14:32:29", kind: "tool", text: "Edited token-store.ts", detail: "+38 −12" },
  { time: "14:32:31", kind: "comment", text: "Should refresh tokens be device-scoped?", detail: "Maya Chen" },
  { time: "14:32:44", kind: "tool", text: "Running authentication test suite", detail: "pnpm test auth" },
];

const files = [
  { name: "token-store.ts", path: "src/auth", change: "+38 −12", status: "modified" },
  { name: "session.service.ts", path: "src/auth", change: "+14 −3", status: "modified" },
  { name: "token-store.test.ts", path: "tests/auth", change: "+72", status: "created" },
];

export function ExecutionWorkspace() {
  const [panel, setPanel] = useState<Panel>("timeline");
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const filteredEvents = useMemo(
    () => events.filter((event) => event.text.toLowerCase().includes(filter.toLowerCase())),
    [filter],
  );

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><span /><span /></div>
          <span>Parallel</span>
        </div>
        <div className="session-title">
          <span className="repo">acme/platform</span>
          <span className="slash">/</span>
          <strong>Fix token rotation race</strong>
          <button className="branch"><GitBranch size={13} /> main <ChevronDown size={13} /></button>
        </div>
        <div className="top-actions">
          <div className="presence">
            <span className="avatar avatar-purple">KS</span>
            <span className="avatar avatar-teal">MC</span>
            <span className="avatar avatar-amber">JL</span>
            <span className="more">+2</span>
          </div>
          <button className="icon-button" aria-label="Search"><Search size={16} /></button>
          <button className="share">Share session</button>
        </div>
      </header>

      <section className="statusbar">
        <div className="live-status">
          <span className={`live-dot ${paused ? "paused" : ""}`} />
          <strong>{paused ? "PAUSED" : "LIVE"}</strong>
          <span>Codex</span>
          <span className="status-divider" />
          <span>42m 18s</span>
        </div>
        <div className="driver"><span>Driver</span><span className="avatar avatar-purple small">KS</span><strong>Kavin</strong></div>
        <div className="execution-controls">
          <button className="control secondary"><Radio size={14} /> Request control</button>
          <button className={`control ${paused ? "resume" : "danger"}`} onClick={() => setPaused(!paused)}>
            {paused ? <Play size={14} /> : <Pause size={14} />}
            {paused ? "Resume execution" : "Emergency pause"}
          </button>
        </div>
      </section>

      <div className="workspace">
        <aside className="rail">
          <button className={panel === "timeline" ? "active" : ""} onClick={() => setPanel("timeline")}>
            <Clock3 size={18} /><span>Timeline</span>
          </button>
          <button className={panel === "artifacts" ? "active" : ""} onClick={() => setPanel("artifacts")}>
            <Box size={18} /><span>Artifacts</span><em>3</em>
          </button>
          <button><GitBranch size={18} /><span>Branches</span><em>2</em></button>
          <button><Users size={18} /><span>People</span><em>5</em></button>
        </aside>

        <section className="execution">
          <div className="pane-heading">
            <div>
              <p className="eyebrow">{panel === "timeline" ? "LIVE EXECUTION" : "SESSION ARTIFACTS"}</p>
              <h1>{panel === "timeline" ? "What the agent is doing" : "Outputs owned by this session"}</h1>
            </div>
            <span className="sequence">seq 1,284</span>
          </div>

          {panel === "timeline" ? (
            <>
              <div className="filter">
                <Search size={14} />
                <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter execution events…" />
                <kbd>⌘ K</kbd>
              </div>
              <div className="timeline">
                {filteredEvents.map((event, index) => (
                  <article className={`event event-${event.kind}`} key={`${event.time}-${event.text}`}>
                    <time>{event.time}</time>
                    <div className="event-line">
                      <span className="event-icon">
                        {event.kind === "tool" ? <TerminalSquare size={14} /> :
                          event.kind === "agent" ? <Code2 size={14} /> :
                          event.kind === "comment" ? <Users size={14} /> :
                          <CircleDot size={14} />}
                      </span>
                      <div>
                        <strong>{event.text}</strong>
                        <p>{event.detail}</p>
                        {index === 4 && (
                          <div className="diff">
                            <div><span className="ln">88</span><code>- await cache.set(key, token)</code></div>
                            <div className="added"><span className="ln">88</span><code>+ await cache.compareAndSwap(key, previous, token)</code></div>
                            <div className="added"><span className="ln">89</span><code>+ audit.record(&quot;token.rotated&quot;, sessionId)</code></div>
                          </div>
                        )}
                      </div>
                    </div>
                  </article>
                ))}
                <div className="running"><span /><span /><span /><p>Tests running</p></div>
              </div>
            </>
          ) : (
            <div className="artifact-grid">
              {files.map((file) => (
                <article className="artifact" key={file.name}>
                  <div className="file-icon"><Code2 size={18} /></div>
                  <div><strong>{file.name}</strong><p>{file.path}</p></div>
                  <span className="change">{file.change}</span>
                  <span className={`file-status ${file.status}`}>{file.status}</span>
                </article>
              ))}
            </div>
          )}
        </section>

        <aside className="context">
          <section>
            <div className="context-heading"><h2>Steering</h2><span className="badge">1 pending</span></div>
            <div className="proposal">
              <div className="proposal-author"><span className="avatar avatar-teal small">MC</span><strong>Maya</strong><time>2m</time></div>
              <p>Make refresh tokens device-scoped and preserve the existing audit trail.</p>
              <div className="proposal-actions"><button className="approve"><Check size={13} /> Approve</button><button>Reject</button></div>
            </div>
            <button className="propose">+ Propose steering</button>
          </section>

          <section>
            <div className="context-heading"><h2>Checkpoint</h2><span className="healthy"><Check size={12} /> Safe</span></div>
            <div className="checkpoint">
              <div className="checkpoint-line"><GitBranch size={14} /><strong>cp_8f2a</strong><span>8m ago</span></div>
              <p>Before token rotation changes</p>
              <button>Fork from here</button>
            </div>
          </section>

          <section>
            <div className="context-heading"><h2>Session health</h2></div>
            <dl className="health-list">
              <div><dt>Event stream</dt><dd><span className="ok-dot" /> Connected</dd></div>
              <div><dt>Provider</dt><dd>43ms</dd></div>
              <div><dt>Last checkpoint</dt><dd>8m</dd></div>
              <div><dt>Uncommitted changes</dt><dd>3 files</dd></div>
            </dl>
          </section>
        </aside>
      </div>

      <footer className="footer">
        <span><AlertTriangle size={13} /> One execution · five collaborators</span>
        <span>All activity is durable and replayable</span>
      </footer>
    </main>
  );
}

