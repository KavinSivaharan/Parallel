"use client";

import type { EventEnvelope, SessionView } from "@parallel/contracts";
import {
  AlertTriangle,
  Box,
  Check,
  CircleDot,
  Code2,
  Download,
  FileDiff,
  GitBranch,
  GitFork,
  LogOut,
  MessageSquare,
  Pause,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Send,
  TerminalSquare,
  Users,
} from "lucide-react";
import { io, type Socket } from "socket.io-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

interface User {
  userId: string;
  email: string;
  displayName: string;
}

interface Organization {
  id: string;
  slug: string;
  name: string;
  role: "owner" | "member" | "viewer";
}

interface SessionSummary {
  sessionId: string;
  branchId: string;
  title: string;
  providerId: string;
  createdAt: string;
}

interface Collaborator {
  userId: string;
  displayName: string;
  email: string;
  role: Organization["role"];
  driver: boolean;
}

interface Artifact {
  id: string;
  name: string;
  mediaType: string;
  byteSize: number;
  contentHash: string;
  version: number;
  createdByEventId: string;
  createdAt: string;
}

interface WorkspaceMetadata {
  id: string;
  repository_path: string;
  repository_url: string | null;
  base_ref: string | null;
  branch: string;
  parent_workspace_id: string | null;
  parent_checkpoint_id: string | null;
  state: string;
}

interface Checkpoint {
  id: string;
  workspace_id: string;
  commit_hash: string;
  parent_commit_hash: string | null;
  parent_checkpoint_id: string | null;
  summary: string;
  created_at: string;
  restored_at: string | null;
}

interface CheckpointComparison {
  files: Array<{
    kind: "created" | "modified" | "deleted" | "renamed";
    path: string;
    previousPath?: string;
  }>;
  patch: string;
}

interface SavedAuth {
  token: string;
  user: User;
}

export function ExecutionWorkspace() {
  const [auth, setAuth] = useState<SavedAuth | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [state, setState] = useState<SessionView | null>(null);
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceMetadata | null>(null);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [connectedUserIds, setConnectedUserIds] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const branchCursorRef = useRef(0);

  const request = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const response = await fetch(`${API}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(auth ? { authorization: `Bearer ${auth.token}` } : {}),
          ...init?.headers,
        },
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Request failed (${response.status})`);
      }
      return response.json() as Promise<T>;
    },
    [auth],
  );

  useEffect(() => {
    const saved = localStorage.getItem("parallel.dev.auth");
    if (saved) setAuth(JSON.parse(saved) as SavedAuth);
  }, []);

  useEffect(() => {
    if (!auth) return;
    void request<Organization[]>("/v1/organizations")
      .then((items) => {
        setOrganizations(items);
        setOrganization((current) => current ?? items[0] ?? null);
      })
      .catch((reason: Error) => setError(reason.message));
  }, [auth, request]);

  useEffect(() => {
    if (!organization) return;
    void request<SessionSummary[]>(`/v1/organizations/${organization.id}/sessions`)
      .then(setSessions)
      .catch((reason: Error) => setError(reason.message));
  }, [organization, request]);

  const refreshRuntime = useCallback(
    async (branchId: string) => {
      const [workspaceResult, checkpointResult] = await Promise.allSettled([
        request<WorkspaceMetadata>(`/v1/branches/${branchId}/workspace`),
        request<Checkpoint[]>(`/v1/branches/${branchId}/checkpoints`),
      ]);
      setWorkspace(workspaceResult.status === "fulfilled" ? workspaceResult.value : null);
      setCheckpoints(checkpointResult.status === "fulfilled" ? checkpointResult.value : []);
    },
    [request],
  );

  const refreshBranch = useCallback(
    async (branchId: string, after = 0) => {
      const [nextState, nextEvents, nextArtifacts, nextCollaborators, replay] = await Promise.all([
        request<SessionView>(`/v1/branches/${branchId}/state`),
        request<EventEnvelope[]>(`/v1/branches/${branchId}/events?after=${after}`),
        request<Artifact[]>(`/v1/branches/${branchId}/artifacts`),
        request<Collaborator[]>(`/v1/branches/${branchId}/collaborators`),
        after === 0
          ? request<{
              events: Array<EventEnvelope & { replaySequence: number }>;
              artifacts: Artifact[];
            }>(`/v1/branches/${branchId}/replay`)
          : Promise.resolve(null),
      ]);
      setState(nextState);
      setEvents((current) => {
        if (replay) {
          return replay.events.map((event) => ({
            ...event,
            sequence: event.replaySequence,
          }));
        }
        const displayHead = current.at(-1)?.sequence ?? 0;
        return orderedUnique([
          ...current,
          ...nextEvents.map((event, index) => ({
            ...event,
            sequence: displayHead + index + 1,
          })),
        ]);
      });
      branchCursorRef.current = Math.max(
        branchCursorRef.current,
        nextEvents.at(-1)?.sequence ?? after,
      );
      setArtifacts((current) =>
        mergeArtifacts(after === 0 ? (replay?.artifacts ?? nextArtifacts) : [...current, ...nextArtifacts]),
      );
      setCollaborators(nextCollaborators);
      await refreshRuntime(branchId);
    },
    [refreshRuntime, request],
  );

  useEffect(() => {
    if (!session || !auth) return;
    setEvents([]);
    branchCursorRef.current = 0;
    setWorkspace(null);
    setCheckpoints([]);
    void refreshBranch(session.branchId).catch((reason: Error) => setError(reason.message));

    const socket = io(`${API}/v1/live`, {
      auth: { token: auth.token },
      transports: ["websocket"],
    });
    socketRef.current = socket;
    socket.on("connect", () => {
      setConnected(true);
      socket.emit("branch.subscribe", { branchId: session.branchId });
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("presence.changed", (presence: { userIds: string[] }) => {
      setConnectedUserIds(presence.userIds);
    });
    socket.on("event.committed", (event: EventEnvelope) => {
      setEvents((current) => {
        if (current.some((item) => item.id === event.id)) return current;
        const expected = (current.at(-1)?.sequence ?? 0) + 1;
        const expectedBranchSequence = branchCursorRef.current + 1;
        if (event.sequence !== expectedBranchSequence) {
          void refreshBranch(session.branchId, branchCursorRef.current);
          return current;
        }
        branchCursorRef.current = event.sequence;
        return [...current, { ...event, sequence: expected }];
      });
      void Promise.all([
        request<SessionView>(`/v1/branches/${session.branchId}/state`).then(setState),
        request<Artifact[]>(`/v1/branches/${session.branchId}/artifacts`).then((items) =>
          setArtifacts((current) => mergeArtifacts([...current, ...items])),
        ),
        request<Collaborator[]>(`/v1/branches/${session.branchId}/collaborators`).then(setCollaborators),
        refreshRuntime(session.branchId),
      ]);
    });
    return () => {
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
      setConnectedUserIds([]);
    };
  }, [auth, refreshBranch, refreshRuntime, request, session]);

  async function command(type: string, payload: Record<string, unknown>): Promise<void> {
    if (!session || !state) return;
    setBusy(true);
    setError(null);
    try {
      await request<EventEnvelope[]>(`/v1/branches/${session.branchId}/commands`, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ type, expectedVersion: state.version, payload }),
      });
      await refreshBranch(session.branchId, branchCursorRef.current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      await refreshBranch(session.branchId);
    } finally {
      setBusy(false);
    }
  }

  async function forkCheckpoint(checkpointId: string): Promise<void> {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const created = await request<{ branchId: string }>(
        `/v1/branches/${session.branchId}/checkpoints/${checkpointId}/forks`,
        {
          method: "POST",
          headers: { "idempotency-key": crypto.randomUUID() },
          body: "{}",
        },
      );
      setSession({
        ...session,
        branchId: created.branchId,
        title: `${session.title} · fork`,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  function compareCheckpoints(
    fromCheckpointId: string,
    toCheckpointId: string,
  ): Promise<CheckpointComparison> {
    if (!session) return Promise.reject(new Error("No execution selected"));
    return request(
      `/v1/branches/${session.branchId}/checkpoints/compare?from=${fromCheckpointId}&to=${toCheckpointId}`,
    );
  }

  async function downloadArtifact(artifact: Artifact): Promise<void> {
    if (!auth) return;
    const response = await fetch(`${API}/v1/artifacts/${artifact.id}/content`, {
      headers: { authorization: `Bearer ${auth.token}` },
    });
    if (!response.ok) {
      setError(`Artifact download failed (${response.status})`);
      return;
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = artifact.name;
    link.click();
    URL.revokeObjectURL(url);
  }

  function saveAuth(next: SavedAuth): void {
    localStorage.setItem("parallel.dev.auth", JSON.stringify(next));
    setAuth(next);
  }

  function signOut(): void {
    localStorage.removeItem("parallel.dev.auth");
    setAuth(null);
    setOrganization(null);
    setSession(null);
    setEvents([]);
    setWorkspace(null);
    setCheckpoints([]);
  }

  if (!auth) return <SignIn onSignedIn={saveAuth} />;
  if (!organization) {
    return (
      <OrganizationSetup
        auth={auth}
        request={request}
        onReady={(next) => {
          setOrganizations((current) => orderedOrganizations([...current, next]));
          setOrganization(next);
        }}
        onSignOut={signOut}
      />
    );
  }
  if (!session || !state) {
    return (
      <SessionPicker
        user={auth.user}
        organization={organization}
        organizations={organizations}
        sessions={sessions}
        request={request}
        onOrganization={setOrganization}
        onSession={async (selected) => {
          setSession(selected);
          const branchState = await request<SessionView>(`/v1/branches/${selected.branchId}/state`);
          if (!branchState.participants.includes(auth.user.userId)) {
            await request(`/v1/branches/${selected.branchId}/commands`, {
              method: "POST",
              headers: { "idempotency-key": crypto.randomUUID() },
              body: JSON.stringify({
                type: "participant.join",
                expectedVersion: branchState.version,
                payload: {},
              }),
            });
          }
        }}
        onCreated={(created) => {
          setSessions((current) => [created, ...current]);
          setSession(created);
        }}
        onSignOut={signOut}
      />
    );
  }

  const isDriver = state.driverId === auth.user.userId;
  const me = collaborators.find((item) => item.userId === auth.user.userId);
  const canCollaborate = me?.role !== "viewer";
  const pendingProposals = events.filter(
    (event) =>
      event.type === "steering.proposed" &&
      !events.some(
        (candidate) =>
          (candidate.type === "steering.approved" || candidate.type === "steering.rejected") &&
          candidate.payload.proposalId === event.payload.proposalId,
      ),
  );

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><span /><span /></div><span>Parallel</span></div>
        <div className="session-title">
          <span className="repo">{organization.name}</span><span className="slash">/</span>
          <strong>{session.title}</strong>
          <button className="branch"><GitBranch size={13} /> {workspace?.branch ?? "provisioning"}</button>
        </div>
        <div className="top-actions">
          <div className="presence">
            {collaborators.filter((person) => connectedUserIds.includes(person.userId)).slice(0, 4).map((person) => (
              <span className={`avatar ${person.driver ? "avatar-purple" : "avatar-teal"}`} title={person.displayName} key={person.userId}>
                {initials(person.displayName)}
              </span>
            ))}
          </div>
          <button className="share" onClick={() => navigator.clipboard.writeText(session.branchId)}>Copy session ID</button>
          <button className="icon-button" aria-label="Leave session" onClick={() => setSession(null)}><LogOut size={15} /></button>
        </div>
      </header>

      <section className="statusbar">
        <div className="live-status">
          <span className={`live-dot ${state.status !== "running" ? "paused" : ""}`} />
          <strong>{state.status.toUpperCase()}</strong><span>{session.providerId}</span>
          <span className="status-divider" /><span>{connected ? "realtime connected" : "catch-up mode"}</span>
        </div>
        <div className="driver">
          <span>Driver</span>
          <span className="avatar avatar-purple small">{initials(collaborators.find((item) => item.driver)?.displayName ?? "?")}</span>
          <strong>{collaborators.find((item) => item.driver)?.displayName ?? "Unassigned"}</strong>
        </div>
        <div className="execution-controls">
          {!isDriver && canCollaborate && (
            <button disabled={busy} className="control secondary" onClick={() => command("driver.request", {})}>
              <Radio size={14} /> Request control
            </button>
          )}
          <button
            disabled={busy || !canCollaborate}
            className={`control ${state.status === "paused" ? "resume" : "danger"}`}
            onClick={() => command(state.status === "paused" ? "session.resume" : "session.pause", state.status === "paused" ? {} : { reason: "Emergency pause from workspace" })}
          >
            {state.status === "paused" ? <Play size={14} /> : <Pause size={14} />}
            {state.status === "paused" ? "Resume" : "Emergency pause"}
          </button>
        </div>
      </section>

      <div className="workspace">
        <aside className="rail">
          <button className="active"><CircleDot size={18} /><span>Timeline</span></button>
          <button><Box size={18} /><span>Artifacts</span><em>{artifacts.length}</em></button>
          <button><Users size={18} /><span>People</span><em>{collaborators.length}</em></button>
        </aside>

        <section className="execution">
          <div className="pane-heading">
            <div><p className="eyebrow">LIVE EXECUTION</p><h1>One shared provider run</h1></div>
            <span className="sequence">seq {state.version}</span>
          </div>
          {error && <div className="inline-error"><AlertTriangle size={14} /> {error}</div>}
          <Composer
            isDriver={isDriver}
            steeringSupported={session.providerId !== "local-workspace"}
            disabled={busy || !canCollaborate || state.status !== "running"}
            onSubmit={(value) =>
              command(isDriver ? "steering.send" : "steering.propose", isDriver
                ? { instruction: value }
                : { proposalId: crypto.randomUUID(), instruction: value })
            }
            onComment={(value) => command("comment.create", { commentId: crypto.randomUUID(), body: value })}
          />
          <div className="timeline live-timeline">
            {events.map((event) => <TimelineEvent event={event} people={collaborators} key={event.id} />)}
            {state.status === "running" && <div className="running"><span /><span /><span /><p>Provider execution active</p></div>}
          </div>
        </section>

        <aside className="context">
          <RuntimePanel
            workspace={workspace}
            checkpoints={checkpoints}
            isDriver={isDriver}
            canFork={canCollaborate}
            busy={busy}
            disabled={busy || state.status !== "running"}
            onCommand={(executable, args) =>
              command("workspace.execute", { executable, args })
            }
            onCheckpoint={(summary) => command("checkpoint.create", { summary })}
            onRestore={(checkpointId) =>
              command("checkpoint.restore", { checkpointId })
            }
            onFork={forkCheckpoint}
            onCompare={compareCheckpoints}
          />

          <section>
            <div className="context-heading"><h2>Steering</h2><span className="badge">{pendingProposals.length} pending</span></div>
            {pendingProposals.length === 0 && <p className="empty-note">No steering proposals awaiting the driver.</p>}
            {pendingProposals.map((proposal) => (
              <div className="proposal" key={proposal.id}>
                <div className="proposal-author"><span className="avatar avatar-teal small">{initials(nameFor(String(proposal.payload.proposerId), collaborators))}</span><strong>{nameFor(String(proposal.payload.proposerId), collaborators)}</strong></div>
                <p>{String(proposal.payload.instruction)}</p>
                {isDriver && <div className="proposal-actions">
                  <button className="approve" onClick={() => command("steering.approve", { proposalId: proposal.payload.proposalId })}><Check size={13} /> Approve</button>
                  <button onClick={() => command("steering.reject", { proposalId: proposal.payload.proposalId })}>Reject</button>
                </div>}
              </div>
            ))}
          </section>

          <section>
            <div className="context-heading"><h2>Collaborators</h2><span className="healthy">{connectedUserIds.length} connected</span></div>
            <div className="people-list">
              {collaborators.map((person) => (
                <div key={person.userId}>
                  <span className={`avatar small ${person.driver ? "avatar-purple" : "avatar-teal"}`}>{initials(person.displayName)}</span>
                  <span><strong>{person.displayName}</strong><small>{person.role}{person.driver ? " · driver" : ""} · {connectedUserIds.includes(person.userId) ? "online" : "offline"}</small></span>
                  {isDriver && !person.driver && person.role !== "viewer" && (
                    <button onClick={() => command("driver.transfer", { toId: person.userId })}>Transfer</button>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section>
            <div className="context-heading"><h2>Artifacts</h2><span className="healthy">{artifacts.length} durable</span></div>
            <div className="artifact-list">
              {artifacts.map((artifact) => (
                <button type="button" onClick={() => void downloadArtifact(artifact)} key={artifact.id}>
                  <Code2 size={14} />
                  <span>
                    <strong>{artifact.name}</strong>
                    <small>{artifact.mediaType} · {artifact.byteSize} B · v{artifact.version}</small>
                  </span>
                  <Download size={12} />
                </button>
              ))}
              {artifacts.length === 0 && <p className="empty-note">Provider artifacts will appear here.</p>}
            </div>
          </section>
        </aside>
      </div>

      <footer className="footer">
        <span><Users size={13} /> One execution · {connectedUserIds.length} connected</span>
        <span>Durable through sequence {state.version}</span>
      </footer>
    </main>
  );
}

function RuntimePanel({
  workspace,
  checkpoints,
  isDriver,
  canFork,
  busy,
  disabled,
  onCommand,
  onCheckpoint,
  onRestore,
  onFork,
  onCompare,
}: {
  workspace: WorkspaceMetadata | null;
  checkpoints: Checkpoint[];
  isDriver: boolean;
  canFork: boolean;
  busy: boolean;
  disabled: boolean;
  onCommand: (executable: string, args: string[]) => Promise<void>;
  onCheckpoint: (summary: string) => Promise<void>;
  onRestore: (checkpointId: string) => Promise<void>;
  onFork: (checkpointId: string) => Promise<void>;
  onCompare: (from: string, to: string) => Promise<CheckpointComparison>;
}) {
  const [executable, setExecutable] = useState("node");
  const [argsText, setArgsText] = useState("[\"--version\"]");
  const [summary, setSummary] = useState("Verified workspace state");
  const [formError, setFormError] = useState<string | null>(null);
  const [comparison, setComparison] = useState<CheckpointComparison | null>(null);

  async function run(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    try {
      const parsed = JSON.parse(argsText) as unknown;
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
        throw new Error("Arguments must be a JSON array of strings");
      }
      await onCommand(executable.trim(), parsed);
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function createCheckpoint(event: React.FormEvent) {
    event.preventDefault();
    if (!summary.trim()) return;
    await onCheckpoint(summary.trim());
  }

  async function compareLatest() {
    const [from, to] = checkpoints.slice(-2);
    if (!from || !to) return;
    setComparison(await onCompare(from.id, to.id));
  }

  return (
    <section className="runtime-panel">
      <div className="context-heading">
        <h2>Workspace runtime</h2>
        <span className={workspace ? "healthy" : "badge"}>
          {workspace ? workspace.state : "provisioning"}
        </span>
      </div>
      {workspace ? (
        <dl className="workspace-meta">
          <div><dt>Branch</dt><dd>{workspace.branch}</dd></div>
          <div><dt>Workspace</dt><dd title={workspace.id}>{workspace.id.slice(0, 12)}</dd></div>
          {workspace.parent_workspace_id && (
            <div><dt>Forked from</dt><dd title={workspace.parent_workspace_id}>{workspace.parent_workspace_id.slice(0, 12)}</dd></div>
          )}
        </dl>
      ) : (
        <p className="empty-note">Creating the execution directory and Git repository…</p>
      )}

      <form className="runtime-command" onSubmit={run}>
        <label>Executable<input value={executable} onChange={(event) => setExecutable(event.target.value)} /></label>
        <label>Arguments (JSON)<textarea value={argsText} onChange={(event) => setArgsText(event.target.value)} /></label>
        {formError && <p className="runtime-error">{formError}</p>}
        <button disabled={disabled || !isDriver || !workspace}>
          <TerminalSquare size={13} /> Run in shared workspace
        </button>
      </form>

      <form className="checkpoint-form" onSubmit={createCheckpoint}>
        <input value={summary} onChange={(event) => setSummary(event.target.value)} aria-label="Checkpoint summary" />
        <button disabled={busy || !isDriver || !workspace}>Checkpoint</button>
      </form>

      <div className="checkpoint-heading">
        <span>{checkpoints.length} checkpoints</span>
        {checkpoints.length >= 2 && (
          <button type="button" disabled={busy} onClick={() => void compareLatest()}>
            <FileDiff size={11} /> Compare latest
          </button>
        )}
      </div>
      {comparison && (
        <div className="comparison-summary">
          <strong>{comparison.files.length} files changed</strong>
          <span>+{countPatchLines(comparison.patch, "+")} −{countPatchLines(comparison.patch, "-")}</span>
        </div>
      )}
      <div className="checkpoint-list">
        {[...checkpoints].reverse().slice(0, 4).map((checkpoint) => (
          <article key={checkpoint.id}>
            <div><GitBranch size={12} /><strong>{checkpoint.summary}</strong></div>
            <small>{checkpoint.commit_hash.slice(0, 9)} · {new Date(checkpoint.created_at).toLocaleTimeString([], { hour12: false })}</small>
            <div className="checkpoint-actions">
              <button type="button" disabled={busy || !isDriver} onClick={() => void onRestore(checkpoint.id)}>
                <RotateCcw size={11} /> Restore
              </button>
              <button type="button" disabled={busy || !canFork} onClick={() => void onFork(checkpoint.id)}>
                <GitFork size={11} /> Fork
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: (auth: SavedAuth) => void }) {
  const [email, setEmail] = useState("alice@parallel.local");
  const [displayName, setDisplayName] = useState("Alice");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const response = await fetch(`${API}/v1/auth/development/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, displayName }),
    });
    if (!response.ok) {
      setError("Development sign-in failed. Is the API running?");
      return;
    }
    const result = (await response.json()) as SavedAuth & { expiresAt: string };
    onSignedIn({ token: result.token, user: result.user });
  }

  return (
    <main className="onboarding">
      <div className="onboarding-card">
        <div className="brand large"><div className="brand-mark"><span /><span /></div><span>Parallel</span></div>
        <p className="eyebrow">DEVELOPMENT IDENTITY</p>
        <h1>Enter the shared execution.</h1>
        <p>Local sign-in exercises the real authenticated collaboration path without external OAuth credentials.</p>
        <form onSubmit={submit}>
          <label>Name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></label>
          <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
          {error && <div className="inline-error">{error}</div>}
          <button type="submit">Continue to Parallel</button>
        </form>
      </div>
    </main>
  );
}

function OrganizationSetup({
  auth,
  request,
  onReady,
  onSignOut,
}: {
  auth: SavedAuth;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  onReady: (organization: Organization) => void;
  onSignOut: () => void;
}) {
  const [name, setName] = useState("Acme Engineering");
  const [slug, setSlug] = useState("acme-engineering");
  const [joinSlug, setJoinSlug] = useState("");
  return (
    <main className="onboarding">
      <div className="onboarding-card wide">
        <div className="onboarding-head"><div><p className="eyebrow">SIGNED IN AS {auth.user.displayName.toUpperCase()}</p><h1>Choose your engineering room.</h1></div><button className="text-button" onClick={onSignOut}>Sign out</button></div>
        <div className="choice-grid">
          <form onSubmit={(event) => { event.preventDefault(); void request<Organization>("/v1/organizations", { method: "POST", body: JSON.stringify({ name, slug }) }).then(onReady); }}>
            <Plus size={22} /><h2>Create an organization</h2>
            <label>Name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>Slug<input value={slug} onChange={(event) => setSlug(event.target.value)} /></label>
            <button>Create organization</button>
          </form>
          <form onSubmit={(event) => { event.preventDefault(); void request<Organization>("/v1/organizations/join", { method: "POST", body: JSON.stringify({ slug: joinSlug }) }).then(onReady); }}>
            <Users size={22} /><h2>Join your team</h2>
            <label>Organization slug<input value={joinSlug} onChange={(event) => setJoinSlug(event.target.value)} placeholder="acme-engineering" /></label>
            <button>Join organization</button>
          </form>
        </div>
      </div>
    </main>
  );
}

function SessionPicker({
  user, organization, organizations, sessions, request, onOrganization, onSession, onCreated, onSignOut,
}: {
  user: User;
  organization: Organization;
  organizations: Organization[];
  sessions: SessionSummary[];
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  onOrganization: (organization: Organization) => void;
  onSession: (session: SessionSummary) => Promise<void>;
  onCreated: (session: SessionSummary) => void;
  onSignOut: () => void;
}) {
  const [title, setTitle] = useState("Shared coding workspace");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [baseRef, setBaseRef] = useState("");
  async function create(event: React.FormEvent) {
    event.preventDefault();
    const created = await request<{ sessionId: string; branchId: string }>("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        organizationId: organization.id,
        title,
        providerId: "local-workspace",
        ...(repositoryUrl.trim() ? { repositoryUrl: repositoryUrl.trim() } : {}),
        ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}),
      }),
    });
    onCreated({ ...created, title, providerId: "local-workspace", createdAt: new Date().toISOString() });
  }
  return (
    <main className="session-home">
      <header><div className="brand"><div className="brand-mark"><span /><span /></div><span>Parallel</span></div><div><span>{user.displayName}</span><button className="text-button" onClick={onSignOut}>Sign out</button></div></header>
      <div className="session-home-body">
        <aside>
          <p className="eyebrow">ORGANIZATIONS</p>
          {organizations.map((item) => <button className={item.id === organization.id ? "selected" : ""} onClick={() => onOrganization(item)} key={item.id}><span>{item.name}</span><small>{item.role}</small></button>)}
        </aside>
        <section>
          <div className="home-heading"><div><p className="eyebrow">LIVE EXECUTIONS</p><h1>{organization.name}</h1></div></div>
          <form className="new-session" onSubmit={create}>
            <input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Execution title" />
            <input value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} placeholder="Git repository URL (optional)" aria-label="Git repository URL" />
            <input value={baseRef} onChange={(event) => setBaseRef(event.target.value)} placeholder="Base branch or tag (optional)" aria-label="Base Git reference" />
            <button><Plus size={15} /> Start real workspace</button>
          </form>
          <div className="session-list">
            {sessions.map((item) => <button key={item.branchId} onClick={() => void onSession(item)}><span className="session-state"><Radio size={15} /></span><span><strong>{item.title}</strong><small>{item.providerId} · main · {new Date(item.createdAt).toLocaleString()}</small></span><span>Open →</span></button>)}
            {sessions.length === 0 && <div className="empty-session"><Radio size={28} /><h2>No executions yet</h2><p>Start one shared provider run above.</p></div>}
          </div>
        </section>
      </div>
    </main>
  );
}

function Composer({ isDriver, steeringSupported, disabled, onSubmit, onComment }: {
  isDriver: boolean;
  steeringSupported: boolean;
  disabled: boolean;
  onSubmit: (value: string) => Promise<void>;
  onComment: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [mode, setMode] = useState<"steer" | "comment">(
    steeringSupported ? "steer" : "comment",
  );
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!value.trim()) return;
    await (mode === "comment" ? onComment(value.trim()) : onSubmit(value.trim()));
    setValue("");
  }
  return (
    <form className="composer" onSubmit={submit}>
      <div className="composer-modes"><button type="button" disabled={!steeringSupported} {...(!steeringSupported ? { title: "This runtime exposes structured commands; agent steering arrives with agent adapters." } : {})} className={mode === "steer" ? "active" : ""} onClick={() => setMode("steer")}><Send size={12} /> {isDriver ? "Instruction" : "Steering proposal"}</button><button type="button" className={mode === "comment" ? "active" : ""} onClick={() => setMode("comment")}><MessageSquare size={12} /> Comment</button></div>
      <div><input value={value} onChange={(event) => setValue(event.target.value)} placeholder={mode === "comment" ? "Comment without affecting the agent…" : isDriver ? "Steer the live execution…" : "Propose steering to the driver…"} /><button disabled={disabled && mode === "steer"}><Send size={14} /></button></div>
    </form>
  );
}

function TimelineEvent({ event, people }: { event: EventEnvelope; people: Collaborator[] }) {
  const presentation = describeEvent(event, people);
  return (
    <article className={`event event-${presentation.kind}`}>
      <time>{new Date(event.occurredAt).toLocaleTimeString([], { hour12: false })}</time>
      <div className="event-line">
        <span className="event-icon">{timelineIcon(presentation.kind)}</span>
        <div><span className={`event-label label-${presentation.kind}`}>{presentation.label}</span><strong>{presentation.title}</strong>{presentation.detail && <p>{presentation.detail}</p>}</div>
      </div>
    </article>
  );
}

function describeEvent(event: EventEnvelope, people: Collaborator[]) {
  const p = event.payload;
  if (event.type === "comment.created") return { kind: "comment", label: "COMMENT", title: String(p.body), detail: nameFor(String(p.authorId), people) };
  if (event.type === "steering.proposed") return { kind: "steering", label: "PROPOSAL", title: String(p.instruction), detail: `Proposed by ${nameFor(String(p.proposerId), people)}` };
  if (event.type === "steering.approved") return { kind: "steering", label: "APPROVED", title: String(p.instruction), detail: `Approved by ${nameFor(String(p.approverId), people)}` };
  if (event.type === "steering.rejected") return { kind: "steering", label: "REJECTED", title: String(p.instruction ?? "Steering proposal rejected"), detail: nameFor(String(p.rejectorId), people) };
  if (event.type === "steering.dispatched") return { kind: "steering", label: "DELIVERED", title: "Instruction delivered to provider", detail: String(p.providerExecutionId) };
  if (event.type === "workspace.created") return { kind: "workspace", label: "WORKSPACE", title: `Workspace ready on ${String(p.branch)}`, detail: String(p.repositoryPath) };
  if (event.type === "workspace.command_requested") return { kind: "terminal", label: "COMMAND QUEUED", title: commandLabel(p), detail: `Requested by ${nameFor(String(p.requestedBy), people)}` };
  if (event.type === "terminal.command_started") return { kind: "terminal", label: "COMMAND STARTED", title: commandLabel(p), detail: String(p.commandId) };
  if (event.type === "terminal.stdout") return { kind: "terminal", label: "STDOUT", title: "Process output", detail: clipText(String(p.chunk ?? "")) };
  if (event.type === "terminal.stderr") return { kind: "error", label: "STDERR", title: "Process warning or error", detail: clipText(String(p.chunk ?? "")) };
  if (event.type === "terminal.command_completed") return { kind: p.exitCode === 0 ? "terminal" : "error", label: "COMMAND COMPLETE", title: p.exitCode === null ? "Process interrupted" : `Exited with code ${String(p.exitCode)}`, detail: `${String(p.durationMs)} ms · ${String(p.commandId)}` };
  if (event.type === "filesystem.changed") {
    const changes = Array.isArray(p.changes) ? p.changes : [];
    return { kind: "filesystem", label: "FILESYSTEM", title: `${changes.length} file${changes.length === 1 ? "" : "s"} changed`, detail: changes.map(fileChangeLabel).join(" · ") };
  }
  if (event.type === "git.diff_created") {
    const files = Array.isArray(p.files) ? p.files : [];
    return { kind: "filesystem", label: "GIT DIFF", title: `${files.length} structured change${files.length === 1 ? "" : "s"}`, detail: files.map(fileChangeLabel).join(" · ") || "Working tree clean" };
  }
  if (event.type === "checkpoint.requested") return { kind: "checkpoint", label: "CHECKPOINT QUEUED", title: String(p.summary), detail: `Requested by ${nameFor(String(p.requestedBy), people)}` };
  if (event.type === "checkpoint.created") return { kind: "checkpoint", label: "CHECKPOINT", title: String(p.summary), detail: `${String(p.commitHash).slice(0, 10)} · ${String(p.branch)}` };
  if (event.type === "checkpoint.restore_requested") return { kind: "checkpoint", label: "RESTORE QUEUED", title: String(p.checkpointId), detail: `Requested by ${nameFor(String(p.requestedBy), people)}` };
  if (event.type === "checkpoint.restored") return { kind: "checkpoint", label: "RESTORED", title: String(p.summary), detail: String(p.commitHash).slice(0, 10) };
  if (event.type === "session.forked") return { kind: "fork", label: "FORK", title: "Independent execution branch created", detail: `From ${String(p.parentBranchId).slice(0, 12)} at ${String(p.parentCheckpointId).slice(0, 8)}` };
  if (event.type === "session.paused") return { kind: "error", label: "EMERGENCY PAUSE", title: String(p.reason), detail: nameFor(String(p.actorId), people) };
  if (event.type === "session.resumed") return { kind: "system", label: "RESUMED", title: "Shared execution resumed", detail: event.actor.kind };
  if (event.type === "provider.output_received") return { kind: "provider", label: "PROVIDER OUTPUT", title: String(p.text), detail: String(p.channel) };
  if (event.type === "provider.failed") return { kind: "error", label: "PROVIDER FAILURE", title: String(p.message), detail: String(p.code) };
  if (event.type === "artifact.created") return { kind: "tool", label: "ARTIFACT", title: String(p.name), detail: `${p.mediaType} · ${p.byteSize} bytes` };
  if (event.type.startsWith("provider.tool")) return { kind: "tool", label: "TOOL", title: `${String(p.name)} ${event.type.endsWith("completed") ? "completed" : "started"}`, detail: String(p.callId) };
  if (event.type === "driver.transferred") return { kind: "system", label: "CONTROL", title: `Driver transferred to ${nameFor(String(p.toId), people)}`, detail: null };
  if (event.type === "driver.transfer_requested") return { kind: "system", label: "CONTROL REQUEST", title: `${nameFor(String(p.requesterId), people)} requested control`, detail: null };
  return { kind: "system", label: "LIFECYCLE", title: event.type.replaceAll(".", " "), detail: event.actor.kind };
}

function timelineIcon(kind: string) {
  if (kind === "provider") return <Code2 size={14} />;
  if (kind === "comment") return <MessageSquare size={14} />;
  if (kind === "steering") return <Send size={14} />;
  if (kind === "terminal" || kind === "tool") return <TerminalSquare size={14} />;
  if (kind === "filesystem") return <FileDiff size={14} />;
  if (kind === "checkpoint") return <GitBranch size={14} />;
  if (kind === "fork") return <GitFork size={14} />;
  if (kind === "error") return <AlertTriangle size={14} />;
  return <CircleDot size={14} />;
}

function commandLabel(payload: Record<string, unknown>): string {
  const args = Array.isArray(payload.args) ? payload.args.map(String) : [];
  return [String(payload.executable ?? "command"), ...args].join(" ");
}

function fileChangeLabel(change: unknown): string {
  if (!change || typeof change !== "object") return "unknown change";
  const item = change as { kind?: unknown; path?: unknown; previousPath?: unknown };
  return item.kind === "renamed"
    ? `renamed ${String(item.previousPath)} → ${String(item.path)}`
    : `${String(item.kind)} ${String(item.path)}`;
}

function clipText(value: string, limit = 2_000): string {
  return value.length > limit ? `${value.slice(0, limit)}\n…output truncated in timeline` : value;
}

function countPatchLines(patch: string, prefix: "+" | "-"): number {
  return patch
    .split("\n")
    .filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`))
    .length;
}

function orderedUnique(events: EventEnvelope[]): EventEnvelope[] {
  return [...new Map(events.map((event) => [event.id, event])).values()].sort((a, b) => a.sequence - b.sequence);
}
function mergeArtifacts(artifacts: Artifact[]): Artifact[] {
  return [...new Map(artifacts.map((artifact) => [artifact.id, artifact])).values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
function orderedOrganizations(items: Organization[]): Organization[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}
function initials(name: string): string {
  return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}
function nameFor(userId: string, people: Collaborator[]): string {
  return people.find((person) => person.userId === userId)?.displayName ?? userId.slice(0, 8);
}
