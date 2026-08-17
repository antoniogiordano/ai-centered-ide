import { describe, expect, it } from "vitest";
import {
  awaitsTestingConfirm,
  canStartCheckGate,
  canStartTestGate,
  deriveProductPhase,
  isAwaitingIdeGate,
  planBuildComplete,
} from "./domain.js";

const completePhases = [
  {
    status: "completed",
    checklist: [{ done: true }, { done: true }],
  },
];

const openPhases = [
  {
    status: "in_progress",
    checklist: [{ done: true }, { done: false }],
  },
];

describe("deriveProductPhase / testing gate helpers", () => {
  it("stays building while checklist is open", () => {
    expect(
      deriveProductPhase({
        mode: "agent",
        planStatus: "executing",
        planPhases: openPhases,
      }),
    ).toBe("building");
  });

  it("enters checking when planStatus is checking", () => {
    expect(
      deriveProductPhase({
        mode: "agent",
        planStatus: "checking",
        planPhases: openPhases,
        testRun: { status: "running" },
      }),
    ).toBe("checking");
  });

  it("enters testing when checklist is complete (before confirm)", () => {
    expect(
      deriveProductPhase({
        mode: "agent",
        planStatus: "executing",
        planPhases: completePhases,
        testRun: null,
      }),
    ).toBe("testing");
  });

  it("stays testing after failed gate (fix loop)", () => {
    expect(
      deriveProductPhase({
        mode: "agent",
        planStatus: "executing",
        planPhases: completePhases,
        testRun: { status: "failed" },
        buildCommitOffer: null,
      }),
    ).toBe("testing");
  });

  it("uses testing while gate is running", () => {
    expect(
      deriveProductPhase({
        mode: "agent",
        planStatus: "executing",
        planPhases: openPhases,
        testRun: { status: "running" },
      }),
    ).toBe("testing");
  });

  it("leaves testing when commit offer exists", () => {
    expect(
      deriveProductPhase({
        mode: "agent",
        planStatus: "executing",
        planPhases: completePhases,
        buildCommitOffer: { offeredAt: "2020-01-01T00:00:00.000Z" },
      }),
    ).toBe("building");
  });

  it("canStartCheckGate only during checking before pass", () => {
    expect(
      canStartCheckGate({
        planStatus: "checking",
        testGatePassedAt: null,
      }),
    ).toBe(true);
    expect(
      canStartCheckGate({
        planStatus: "checking",
        testGatePassedAt: "2020-01-01T00:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      canStartCheckGate({
        planStatus: "executing",
        testGatePassedAt: null,
      }),
    ).toBe(false);
  });

  it("awaitsTestingConfirm only before propose_testing_ready", () => {
    const base = {
      planStatus: "executing",
      planPhases: completePhases,
      testingConfirmedAt: null as string | null,
      testGatePassedAt: null as string | null,
      buildCommitOffer: null,
      buildIntegrateOffer: null,
    };
    expect(planBuildComplete(base)).toBe(true);
    expect(awaitsTestingConfirm(base)).toBe(true);
    expect(canStartTestGate(base)).toBe(false);

    const confirmed = {
      ...base,
      testingConfirmedAt: "2020-01-01T00:00:00.000Z",
    };
    expect(awaitsTestingConfirm(confirmed)).toBe(false);
    expect(canStartTestGate(confirmed)).toBe(true);
  });

  it("isAwaitingIdeGate while check/test gate pending or running", () => {
    expect(
      isAwaitingIdeGate({
        planStatus: "checking",
        testRun: null,
        testGatePassedAt: null,
      }),
    ).toBe(true);
    expect(
      isAwaitingIdeGate({
        planStatus: "checking",
        testRun: { status: "running" },
        testGatePassedAt: null,
      }),
    ).toBe(true);
    expect(
      isAwaitingIdeGate({
        planStatus: "checking",
        testRun: { status: "failed" },
        testGatePassedAt: null,
      }),
    ).toBe(false);
    expect(
      isAwaitingIdeGate({
        testingConfirmedAt: "2020-01-01T00:00:00.000Z",
        testRun: null,
        testGatePassedAt: null,
      }),
    ).toBe(true);
    expect(
      isAwaitingIdeGate({
        testingConfirmedAt: "2020-01-01T00:00:00.000Z",
        testRun: { status: "failed" },
        testGatePassedAt: null,
      }),
    ).toBe(false);
  });

  it("gate helpers reject incomplete checklist", () => {
    const incomplete = {
      planStatus: "executing",
      planPhases: openPhases,
      testingConfirmedAt: "2020-01-01T00:00:00.000Z",
      testGatePassedAt: null,
      buildCommitOffer: null,
      buildIntegrateOffer: null,
    };
    expect(awaitsTestingConfirm(incomplete)).toBe(false);
    expect(canStartTestGate(incomplete)).toBe(false);
  });
});
