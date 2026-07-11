import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Page = "overview" | "sessions" | "memories" | "diagnostics";
type Envelope<T> = { data: T };

const csrf = document.querySelector<HTMLMetaElement>('meta[name="termyte-csrf"]')?.content ?? "";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", "x-termyte-csrf": csrf, ...(init?.headers ?? {}) },
  });
  const payload = await response.json() as Envelope<T> | { error: { message: string } };
  if (!response.ok || "error" in payload) throw new Error("error" in payload ? payload.error.message : `Request failed (${response.status})`);
  return payload.data;
}

function App() {
  const [page, setPage] = useState<Page>("overview");
  return <div className="shell">
    <aside>
      <div className="brand"><span className="mark">T</span><div><b>TERMYTE</b><small>CONTEXT ENGINE</small></div></div>
      <nav>{(["overview", "sessions", "memories", "diagnostics"] as Page[]).map(item =>
        <button className={page === item ? "active" : ""} onClick={() => setPage(item)} key={item}>{item}</button>
      )}</nav>
      <div className="local"><i /> LOCAL · PRIVATE</div>
    </aside>
    <main>
      {page === "overview" && <Overview />}
      {page === "sessions" && <Sessions />}
      {page === "memories" && <Memories />}
      {page === "diagnostics" && <Diagnostics />}
    </main>
  </div>;
}

function Header({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }) {
  return <header><span>{eyebrow}</span><h1>{title}</h1><p>{copy}</p></header>;
}

function Overview() {
  const [value, setValue] = useState<any>();
  const [error, setError] = useState("");
  useEffect(() => { api<any>("/api/overview").then(setValue).catch(e => setError(e.message)); }, []);
  return <><Header eyebrow="SYSTEM OVERVIEW" title="Agent experience, made legible." copy="Termyte observes work quietly and shows the context your coding agents carry forward." />
    {error && <Notice text={error} />}
    <section className="metrics">{["sessions", "episodes", "traces", "memories", "packets"].map(k => <article key={k}><small>{k}</small><strong>{value?.[k] ?? "—"}</strong></article>)}</section>
    <section className="panel hero"><div><small>CONTEXT PIPELINE</small><h2>Evidence → Experience → Memory → Context</h2><p>Every derived memory remains connected to the work that produced it. Nothing shown here is detached from provenance.</p></div><Health health={value?.health} /></section>
  </>;
}

function Sessions() {
  const [sessions, setSessions] = useState<any[]>([]);
  const [detail, setDetail] = useState<any>();
  useEffect(() => { api<any[]>("/api/sessions").then(setSessions); }, []);
  async function open(id: string) { setDetail(await api(`/api/sessions/${encodeURIComponent(id)}`)); }
  return <><Header eyebrow="EXECUTION HISTORY" title="Sessions and experiences" copy="Inspect what each agent attempted, the evidence it produced, and the context prepared for later work." />
    <section className="split"><div className="panel list">{sessions.map(s => <button key={s.session_id} onClick={() => open(s.session_id)}><div><b>{s.project}</b><span>{s.session_id}</span></div><Status value={s.ended_at ? "complete" : "active"} /></button>)}</div>
    <div className="panel detail">{detail ? <><h2>{detail.session.project}</h2><p className="mono">{detail.session.session_id}</p><h3>Episodes</h3>{detail.episodes.map((e: any) => <EpisodeCard key={e.id} episode={e} />)}<h3>Context packets</h3>{detail.packets.map((p: any) => <ContextCard key={p.id} packet={p} />)}</> : <Empty text="Select a session to inspect its experience." />}</div></section>
  </>;
}

function EpisodeCard({ episode }: { episode: any }) {
  const [open, setOpen] = useState(false); const [detail, setDetail] = useState<any>();
  async function toggle() { if (!open && !detail) setDetail(await api(`/api/episodes/${episode.id}`)); setOpen(!open); }
  async function outcome(status: string) { await api(`/api/episodes/${episode.id}/outcomes`, { method: "POST", body: JSON.stringify({ status }) }); setDetail(await api(`/api/episodes/${episode.id}`)); }
  return <div className="card"><button onClick={toggle}><b>{episode.task}</b><Status value={episode.status} /></button>{open && detail && <div className="card-body"><div className="actions"><button onClick={() => outcome("succeeded")}>Succeeded</button><button onClick={() => outcome("failed")}>Failed</button><button onClick={() => outcome("partial")}>Partial</button></div><h4>Evidence</h4>{detail.evidence.map((e: any) => <pre key={e.id}><span>{e.kind}</span>{e.content}</pre>)}</div>}</div>;
}

function ContextCard({ packet }: { packet: any }) {
  const [detail, setDetail] = useState<any>();
  return <div className="card"><button onClick={async () => setDetail(detail ? undefined : await api(`/api/context-packets/${packet.id}`))}><b>{packet.task}</b><span>{packet.estimated_tokens}/{packet.token_budget} tokens</span></button>{detail && <div className="card-body"><pre>{detail.packet.rendered_text}</pre><h4>Candidate decisions</h4>{detail.candidates.map((c: any) => <div className="candidate" key={c.candidate_id}><Status value={c.selected ? "selected" : "rejected"} /><span>{c.candidate_id}</span><small>{c.rejection_reason ?? c.final_score.toFixed(4)}</small></div>)}</div>}</div>;
}

function Memories() {
  const [memories, setMemories] = useState<any[]>([]); const [detail, setDetail] = useState<any>();
  const load = () => api<any[]>("/api/memories").then(setMemories); useEffect(() => { load(); }, []);
  async function feedback(event: string) { await api(`/api/memories/${detail.memory.id}/feedback`, { method: "POST", body: JSON.stringify({ event }) }); setDetail(await api(`/api/memories/${detail.memory.id}`)); }
  return <><Header eyebrow="ACCUMULATED CONTEXT" title="Memories" copy="Reusable knowledge derived from experience, with lifecycle, evidence, and correction history." /><section className="split"><div className="panel list">{memories.map(m => <button key={m.id} onClick={async () => setDetail(await api(`/api/memories/${m.id}`))}><div><b>{m.title}</b><span>{m.type}</span></div><Status value={m.lifecycle_state ?? m.state} /></button>)}</div><div className="panel detail">{detail ? <><small>{detail.memory.type}</small><h2>{detail.memory.title}</h2><p>{detail.memory.description}</p><div className="actions"><button onClick={() => feedback("helpful")}>Helpful</button><button onClick={() => feedback("irrelevant")}>Irrelevant</button><button className="danger" onClick={() => feedback("harmful")}>Harmful</button></div><h3>Provenance</h3><p className="mono">Traces: {detail.memory.source_trace_ids.join(", ") || "none"}</p><h3>Feedback</h3>{detail.feedback.map((f: any) => <div className="candidate" key={f.id}><Status value={f.event_type} /><span>{f.source}</span></div>)}</> : <Empty text="Select a memory to inspect its provenance." />}</div></section></>;
}

function Diagnostics() {
  const [value, setValue] = useState<any>(); useEffect(() => { api("/api/diagnostics").then(setValue); }, []);
  return <><Header eyebrow="LOCAL RUNTIME" title="Diagnostics" copy="Capture, durable processing, and failures remain invisible during agent work and inspectable here." /><section className="metrics"><article><small>pending</small><strong>{value?.health.queue.pending ?? "—"}</strong></article><article><small>failed</small><strong>{value?.health.queue.failed ?? "—"}</strong></article><article><small>dead</small><strong>{value?.health.queue.dead ?? "—"}</strong></article></section><section className="panel"><h2>Problem work</h2>{value?.problemJobs.length ? value.problemJobs.map((j: any) => <pre key={j.id}>{j.state} · {j.kind} · {j.last_error}</pre>) : <Empty text="No failed or dead-lettered work." />}<h2>Audit history</h2>{value?.audit.slice(0, 20).map((a: any) => <div className="candidate" key={a.id}><span>{a.operation}</span><small>{a.timestamp}</small></div>)}</section></>;
}

function Health({ health }: { health: any }) { return <div className="health"><i className={health?.queue?.dead ? "bad" : ""} /><div><b>{health?.queue?.dead ? "Needs attention" : "Runtime healthy"}</b><span>{health?.queue?.pending ?? 0} pending · {health?.queue?.dead ?? 0} dead</span></div></div>; }
function Status({ value }: { value: string }) { return <span className={`status ${value}`}>{value}</span>; }
function Empty({ text }: { text: string }) { return <div className="empty">{text}</div>; }
function Notice({ text }: { text: string }) { return <div className="notice">{text}</div>; }

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
