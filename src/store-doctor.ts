import type { SqlDatabaseLike } from './store-types.js';

/**
 * Doctor diagnostics operations.
 * Analyzes store health: summary graph integrity, FTS index consistency, orphan detection.
 */

export type DoctorSessionIssue = {
  sessionID: string;
  issues: string[];
};

export type DoctorReport = {
  scope: string;
  checkedSessions: number;
  summarySessionsNeedingRebuild: DoctorSessionIssue[];
  lineageSessionsNeedingRefresh: string[];
  orphanSummaryEdges: number;
  messageFts: { expected: number; actual: number };
  summaryFts: { expected: number; actual: number };
  artifactFts: { expected: number; actual: number };
  orphanArtifactBlobs: number;
  status: 'clean' | 'issues-found';
};

type SessionSnapshot = {
  sessionID: string;
  messages: { info: { id: string; time: { created: number } }; parts: unknown[] }[];
  rootSessionID?: string;
  lineageDepth?: number;
};

type SummaryStateRow = {
  archived_count: number;
  latest_message_created: number;
  archived_signature: string;
  root_node_ids_json: string;
};

type SummaryNodeRow = {
  node_id: string;
  session_id: string;
  level: number;
  slot: number;
  archived_message_ids_json: string;
  summary_text: string;
  created_at: number;
};

type DoctorDeps = {
  db: SqlDatabaseLike;
  getArchivedMessages: (messages: SessionSnapshot['messages']) => SessionSnapshot['messages'];
  buildArchivedSignature: (messages: SessionSnapshot['messages']) => string;
  readSummaryNode: (nodeID: string) => SummaryNodeRow | undefined;
  canReuseSummaryGraph: (
    sessionID: string,
    archived: SessionSnapshot['messages'],
    roots: SummaryNodeRow[],
  ) => boolean;
  readScopedSummaryRows: (sessionIDs?: string[]) => unknown[];
  readScopedArtifactRows: (sessionIDs?: string[]) => unknown[];
  readOrphanArtifactBlobRows: () => unknown[];
  countScopedFtsRows: (
    table: 'message_fts' | 'summary_fts' | 'artifact_fts',
    sessionIDs?: string[],
  ) => number;
  countScopedOrphanSummaryEdges: (sessionIDs?: string[]) => number;
  guessMessageText: (
    message: SessionSnapshot['messages'][number],
    ignorePrefixes: string[],
  ) => string;
  ignoreToolPrefixes: string[];
  parseJson: <T>(value: string) => T;
};

function countFtsExpected(sessions: SessionSnapshot[], deps: DoctorDeps): number {
  return sessions.reduce((count, session) => {
    return (
      count +
      session.messages.filter(
        (message) => deps.guessMessageText(message, deps.ignoreToolPrefixes).length > 0,
      ).length
    );
  }, 0);
}

function diagnoseSummarySession(
  session: SessionSnapshot,
  deps: DoctorDeps,
): DoctorSessionIssue | undefined {
  const issues: string[] = [];
  const archived = deps.getArchivedMessages(session.messages);
  const state = deps.db
    .prepare('SELECT * FROM summary_state WHERE session_id = ?')
    .get(session.sessionID) as SummaryStateRow | undefined;
  const summaryNodeCount = deps.db
    .prepare('SELECT COUNT(*) AS count FROM summary_nodes WHERE session_id = ?')
    .get(session.sessionID) as { count: number };
  const summaryEdgeCount = deps.db
    .prepare('SELECT COUNT(*) AS count FROM summary_edges WHERE session_id = ?')
    .get(session.sessionID) as { count: number };

  if (archived.length === 0) {
    if (state) issues.push('unexpected-summary-state');
    if (summaryNodeCount.count > 0) issues.push('unexpected-summary-nodes');
    if (summaryEdgeCount.count > 0) issues.push('unexpected-summary-edges');
    return issues.length > 0 ? { sessionID: session.sessionID, issues } : undefined;
  }

  const latestMessageCreated = archived.at(-1)?.info.time.created ?? 0;
  const archivedSignature = deps.buildArchivedSignature(archived);
  const rootIDs = state ? deps.parseJson<string[]>(state.root_node_ids_json) : [];
  const roots = rootIDs
    .map((nodeID) => deps.readSummaryNode(nodeID))
    .filter((node): node is SummaryNodeRow => Boolean(node));

  if (!state) {
    issues.push('missing-summary-state');
  } else {
    if (state.archived_count !== archived.length) issues.push('archived-count-mismatch');
    if (state.latest_message_created !== latestMessageCreated)
      issues.push('latest-message-mismatch');
    if (state.archived_signature !== archivedSignature) issues.push('archived-signature-mismatch');
    if (rootIDs.length === 0) issues.push('missing-root-node-ids');
    if (roots.length !== rootIDs.length) {
      issues.push('missing-root-node-record');
    } else if (
      rootIDs.length > 0 &&
      !deps.canReuseSummaryGraph(session.sessionID, archived, roots)
    ) {
      issues.push('invalid-summary-graph');
    }
  }

  if (summaryNodeCount.count === 0) issues.push('missing-summary-nodes');
  return issues.length > 0 ? { sessionID: session.sessionID, issues } : undefined;
}

function needsLineageRefresh(
  session: SessionSnapshot,
  readLineageChain: (sessionID: string) => { sessionID: string }[],
): boolean {
  const chain = readLineageChain(session.sessionID);
  const expectedRoot = chain[0]?.sessionID ?? session.sessionID;
  const expectedDepth = Math.max(0, chain.length - 1);
  return (
    (session.rootSessionID ?? session.sessionID) !== expectedRoot ||
    (session.lineageDepth ?? 0) !== expectedDepth
  );
}

export function collectDoctorReport(
  sessions: SessionSnapshot[],
  sessionID: string | undefined,
  deps: DoctorDeps,
  readLineageChain: (sessionID: string) => { sessionID: string }[],
): DoctorReport {
  const sessionIDs = sessions.map((session) => session.sessionID);
  const summarySessionsNeedingRebuild = sessions
    .map((session) => diagnoseSummarySession(session, deps))
    .filter((issue): issue is DoctorSessionIssue => Boolean(issue));
  const lineageSessionsNeedingRefresh = sessions
    .filter((session) => needsLineageRefresh(session, readLineageChain))
    .map((session) => session.sessionID);

  const messageFtsExpected = countFtsExpected(sessions, deps);

  const report: DoctorReport = {
    scope: sessionID ? `session:${sessionID}` : 'all',
    checkedSessions: sessions.length,
    summarySessionsNeedingRebuild,
    lineageSessionsNeedingRefresh,
    orphanSummaryEdges: deps.countScopedOrphanSummaryEdges(sessionIDs),
    messageFts: {
      expected: messageFtsExpected,
      actual: deps.countScopedFtsRows('message_fts', sessionIDs),
    },
    summaryFts: {
      expected: deps.readScopedSummaryRows(sessionIDs).length,
      actual: deps.countScopedFtsRows('summary_fts', sessionIDs),
    },
    artifactFts: {
      expected: deps.readScopedArtifactRows(sessionIDs).length,
      actual: deps.countScopedFtsRows('artifact_fts', sessionIDs),
    },
    orphanArtifactBlobs: deps.readOrphanArtifactBlobRows().length,
    status: 'clean',
  };

  report.status = hasDoctorIssues(report) ? 'issues-found' : 'clean';
  return report;
}

export function hasDoctorIssues(report: DoctorReport): boolean {
  return (
    report.summarySessionsNeedingRebuild.length > 0 ||
    report.lineageSessionsNeedingRefresh.length > 0 ||
    report.orphanSummaryEdges > 0 ||
    report.messageFts.expected !== report.messageFts.actual ||
    report.summaryFts.expected !== report.summaryFts.actual ||
    report.artifactFts.expected !== report.artifactFts.actual ||
    report.orphanArtifactBlobs > 0
  );
}
