import { describe, expect, it } from "vitest";
import {
  HARNESS_VISION_NOTICE_ID,
  SessionNoticeSchema,
  createEmptySessionState,
  noticesBlocking,
  pruneExpiredNotices,
  upsertSessionNotice,
} from "./domain.js";

function notice(
  overrides: Partial<Parameters<typeof SessionNoticeSchema.parse>[0]> = {},
) {
  return SessionNoticeSchema.parse({
    id: "n1",
    kind: "warning",
    title: "Images were not sent",
    createdAt: "2026-08-20T16:00:00.000Z",
    ...overrides,
  });
}

describe("session notices", () => {
  it("starts empty on a new session", () => {
    expect(createEmptySessionState("s1").notices).toEqual([]);
  });

  it("replaces the same id so a harness intercept does not stack", () => {
    const first = notice({
      id: HARNESS_VISION_NOTICE_ID,
      detail: "first",
    });
    const second = notice({
      id: HARNESS_VISION_NOTICE_ID,
      detail: "second",
    });
    const next = upsertSessionNotice(upsertSessionNotice([], first), second);
    expect(next).toHaveLength(1);
    expect(next[0]?.detail).toBe("second");
  });

  it("treats a blocking unexpired notice as blocking", () => {
    expect(noticesBlocking([notice({ blocking: true })])).toBe(true);
    expect(noticesBlocking([notice({ blocking: false })])).toBe(false);
  });

  it("drops expired notices", () => {
    const expired = notice({
      expiresAt: "2026-08-20T15:00:00.000Z",
    });
    const live = notice({
      id: "n2",
      expiresAt: "2026-08-20T17:00:00.000Z",
    });
    const now = Date.parse("2026-08-20T16:00:00.000Z");
    expect(pruneExpiredNotices([expired, live], now).map((n) => n.id)).toEqual([
      "n2",
    ]);
    expect(noticesBlocking([notice({ blocking: true, expiresAt: expired.expiresAt })], now)).toBe(
      false,
    );
  });
});
