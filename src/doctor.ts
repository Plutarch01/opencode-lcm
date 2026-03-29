export type DoctorSessionIssue = {
  sessionID: string;
  issues: string[];
};

export type DoctorCountCheck = {
  expected: number;
  actual: number;
};

export type DoctorReport = {
  scope: string;
  checkedSessions: number;
  summarySessionsNeedingRebuild: DoctorSessionIssue[];
  lineageSessionsNeedingRefresh: string[];
  orphanSummaryEdges: number;
  messageFts: DoctorCountCheck;
  summaryFts: DoctorCountCheck;
  artifactFts: DoctorCountCheck;
  orphanArtifactBlobs: number;
  status: "clean" | "issues-found" | "repaired";
  appliedActions?: string[];
};

function formatCountCheck(label: string, value: DoctorCountCheck): string[] {
  return [
    `${label}_expected=${value.expected}`,
    `${label}_actual=${value.actual}`,
    `${label}_delta=${value.expected - value.actual}`,
  ];
}

export function formatDoctorReport(report: DoctorReport, limit: number): string {
  const issueCount =
    report.summarySessionsNeedingRebuild.length +
    report.lineageSessionsNeedingRefresh.length +
    report.orphanSummaryEdges +
    Math.abs(report.messageFts.expected - report.messageFts.actual) +
    Math.abs(report.summaryFts.expected - report.summaryFts.actual) +
    Math.abs(report.artifactFts.expected - report.artifactFts.actual) +
    report.orphanArtifactBlobs;

  const lines = [
    `checked_scope=${report.scope}`,
    `checked_sessions=${report.checkedSessions}`,
    `summary_sessions_needing_rebuild=${report.summarySessionsNeedingRebuild.length}`,
    `lineage_sessions_needing_refresh=${report.lineageSessionsNeedingRefresh.length}`,
    `orphan_summary_edges=${report.orphanSummaryEdges}`,
    ...formatCountCheck("message_fts", report.messageFts),
    ...formatCountCheck("summary_fts", report.summaryFts),
    ...formatCountCheck("artifact_fts", report.artifactFts),
    `orphan_artifact_blobs=${report.orphanArtifactBlobs}`,
    `issues=${issueCount}`,
    `status=${report.status}`,
  ];

  if (report.summarySessionsNeedingRebuild.length > 0) {
    lines.push(
      "summary_session_preview:",
      ...report.summarySessionsNeedingRebuild
        .slice(0, limit)
        .map((issue) => `- ${issue.sessionID}: ${issue.issues.join(", ")}`),
    );
  }

  if (report.lineageSessionsNeedingRefresh.length > 0) {
    lines.push(
      "lineage_session_preview:",
      ...report.lineageSessionsNeedingRefresh
        .slice(0, limit)
        .map((sessionID) => `- ${sessionID}`),
    );
  }

  if (report.appliedActions && report.appliedActions.length > 0) {
    lines.push("applied_actions:", ...report.appliedActions.slice(0, limit).map((action) => `- ${action}`));
  } else if (report.status === "issues-found") {
    lines.push("Re-run with apply=true to repair the issues above.");
  }

  return lines.join("\n");
}
