import { useState } from "react";
import type { ReportRow } from "./runClient.js";

function CopyButton({ text }: { text: string }) {
  const [msg, setMsg] = useState("");
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setMsg("Copied"); } catch { setMsg("Copy unavailable"); }
    window.setTimeout(() => setMsg(""), 2000);
  };
  return <><button type="button" className="copy" onClick={() => { void copy(); }}>Copy</button><span className="copied" role="status">{msg}</span></>;
}

/** The final (leaf) task reports. Reports are untrusted model output: always plain text in a <pre>, never HTML or markdown. */
export function AnswerPanel({ reports }: { reports: ReportRow[] }) {
  return (
    <section className="answer" aria-label="Answer">
      {reports.map((r) => (
        <article key={r.task_id} className="answer-block">
          <header><h2 className="mono">{r.task_id}</h2><CopyButton text={r.body} /></header>
          <pre className="answer-text" data-testid={`answer-${r.task_id}`}>{r.body}</pre>
        </article>
      ))}
    </section>
  );
}
