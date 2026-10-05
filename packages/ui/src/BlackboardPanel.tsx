import { useMemo } from "react";
import type { BbEntry } from "@mar/core";
import type { FlowEdge } from "./derive.js";

export function BlackboardPanel({ entries, flow }: { entries: BbEntry[]; flow: FlowEdge[] }) {
  const readers = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const f of flow) { const s = m.get(f.key) ?? new Set<string>(); s.add(f.to); m.set(f.key, s); }
    return m;
  }, [flow]);
  if (entries.length === 0) return <section className="bb" aria-label="Blackboard"><p className="muted">Blackboard is empty.</p></section>;
  return (
    <section className="bb" aria-label="Blackboard">
      <table>
        <thead><tr><th>Key</th><th>Ver</th><th>Kind</th><th>Author</th><th>Readers</th><th>Body</th></tr></thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="mono">{e.key}</td><td>v{e.version}</td><td>{e.kind}</td><td className="mono">{e.author_task}</td>
              <td className="mono">{[...(readers.get(e.key) ?? [])].join(", ") || "none"}</td>
              <td><pre>{e.body}</pre></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
