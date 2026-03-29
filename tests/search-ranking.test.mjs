import test from "node:test";
import assert from "node:assert/strict";

import { rankSearchCandidates } from "../dist/search-ranking.js";

test("rankSearchCandidates gives newer exact hits a real recency boost", () => {
  const ranked = rankSearchCandidates(
    [
      {
        id: "old",
        type: "user",
        sessionID: "s1",
        timestamp: 10,
        snippet: "tenant mapping sqlite lives in billing cache",
        content: "tenant mapping sqlite lives in billing cache",
        sourceKind: "message",
        sourceOrder: 0,
      },
      {
        id: "new",
        type: "user",
        sessionID: "s1",
        timestamp: 100,
        snippet: "tenant mapping sqlite lives in billing cache",
        content: "tenant mapping sqlite lives in billing cache",
        sourceKind: "message",
        sourceOrder: 40,
      },
    ],
    "tenant mapping sqlite",
    5,
  );

  assert.equal(ranked[0].id, "new");
});

test("rankSearchCandidates still prefers materially stronger lexical matches", () => {
  const ranked = rankSearchCandidates(
    [
      {
        id: "older-strong",
        type: "user",
        sessionID: "s1",
        timestamp: 10,
        snippet: "tenant mapping sqlite lives in billing cache",
        content: "tenant mapping sqlite lives in billing cache",
        sourceKind: "message",
        sourceOrder: 0,
      },
      {
        id: "newer-weak",
        type: "user",
        sessionID: "s1",
        timestamp: 100,
        snippet: "tenant mapping lives in cache",
        content: "tenant mapping lives in cache",
        sourceKind: "message",
        sourceOrder: 40,
      },
    ],
    "tenant mapping sqlite",
    5,
  );

  assert.equal(ranked[0].id, "older-strong");
});
