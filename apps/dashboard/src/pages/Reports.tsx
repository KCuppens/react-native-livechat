import type { CsatReport } from "@kobecuppens/livechat-protocol";
import { useEffect, useState } from "react";
import { api } from "../api";
import { Spinner } from "../components/ui";
import { Link } from "../router";

export function ReportsPage({ workspaceId }: { workspaceId: string }) {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<CsatReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [attemptNo, setAttemptNo] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attemptNo is the Retry trigger
  useEffect(() => {
    // Ignore responses from a previous period: a slow 90-day report must not replace the 7-day one.
    let current = true;
    setReport(null);
    setFailed(false);
    api.report(workspaceId, days).then(
      (r) => current && setReport(r),
      () => current && setFailed(true),
    );
    return () => {
      current = false;
    };
  }, [workspaceId, days, attemptNo]);
  const max = Math.max(1, ...(report?.distribution ?? []));
  return (
    <div className="page">
      <div className="page-header">
        <h1>Reports</h1>
        <select className="select" style={{ width: 160 }} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>
      {failed ? (
        <div className="empty">
          Couldn't load the report.{" "}
          <button type="button" className="btn btn-sm" onClick={() => setAttemptNo((n) => n + 1)}>
            Retry
          </button>
        </div>
      ) : !report ? (
        <Spinner />
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat">
              <span>Conversations</span>
              <strong>{report.conversations}</strong>
            </div>
            <div className="stat">
              <span>Resolved</span>
              <strong>{report.resolved}</strong>
            </div>
            <div className="stat">
              <span>Median first reply</span>
              <strong>{report.medianFirstResponseMinutes === null ? "—" : formatMinutes(report.medianFirstResponseMinutes)}</strong>
            </div>
            <div className="stat">
              <span>Satisfaction</span>
              <strong>{report.average === null ? "—" : `${report.average.toFixed(1)} / 5`}</strong>
              <span>{report.responses} ratings</span>
            </div>
          </div>
          <div className="card">
            <h2 style={{ marginBottom: 12 }}>Ratings</h2>
            {[5, 4, 3, 2, 1].map((score) => {
              const n = report.distribution[score - 1]!;
              return (
                <div className="bar-row" key={score}>
                  <span>{score} ★</span>
                  <div className="bar" role="img" aria-label={`${n} ratings of ${score}`}>
                    <i style={{ width: `${(n / max) * 100}%` }} />
                  </div>
                  <span className="muted">{n}</span>
                </div>
              );
            })}
          </div>
          <div className="card">
            <h2 style={{ marginBottom: 12 }}>Recent comments</h2>
            {report.recentComments.length === 0 ? (
              <p className="muted">No comments yet.</p>
            ) : (
              <table className="table">
                <tbody>
                  {report.recentComments.map((c) => (
                    <tr key={c.conversationId}>
                      <td style={{ width: 90 }}>{"★".repeat(c.score)}</td>
                      <td>“{c.comment}”</td>
                      <td style={{ textAlign: "right" }}>
                        <Link to={`/w/${workspaceId}/inbox/${c.conversationId}`}>Open</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function formatMinutes(m: number) {
  if (m < 1) return "<1m";
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}
