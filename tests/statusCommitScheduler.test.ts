import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusCommitScheduler } from "../src/sidebar/statusCommitScheduler";

afterEach(() => vi.useRealTimers());

describe("status commit scheduler", () => {
  it("commits only the latest status after a continuous 800 ms", async () => {
    vi.useFakeTimers();
    const scheduler = new StatusCommitScheduler(800);
    const commit = vi.fn();

    scheduler.schedule("card-1", "done", commit);
    await vi.advanceTimersByTimeAsync(150);
    scheduler.schedule("card-1", "rejected", commit);
    await vi.advanceTimersByTimeAsync(200);
    scheduler.schedule("card-1", "trash", commit);
    await vi.advanceTimersByTimeAsync(799);

    expect(commit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith("card-1", "trash");
  });

  it("cancels pending work during cleanup", async () => {
    vi.useFakeTimers();
    const scheduler = new StatusCommitScheduler(800);
    const commit = vi.fn();
    scheduler.schedule("card-1", "done", commit);
    scheduler.cancelAll();

    await vi.runAllTimersAsync();
    expect(commit).not.toHaveBeenCalled();
  });

  it("keeps pending commits isolated per card", async () => {
    vi.useFakeTimers();
    const scheduler = new StatusCommitScheduler(800);
    const commit = vi.fn();

    scheduler.schedule("card-1", "started", commit);
    scheduler.schedule("card-2", "done", commit);
    await vi.advanceTimersByTimeAsync(400);
    scheduler.schedule("card-1", "to validate", commit);
    await vi.advanceTimersByTimeAsync(400);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith("card-2", "done");
    await vi.advanceTimersByTimeAsync(400);
    expect(commit).toHaveBeenLastCalledWith("card-1", "to validate");
  });

  it("cancels one card without affecting another", async () => {
    vi.useFakeTimers();
    const scheduler = new StatusCommitScheduler(800);
    const commit = vi.fn();

    scheduler.schedule("card-1", "done", commit);
    scheduler.schedule("card-2", "rejected", commit);
    scheduler.cancel("card-1");
    await vi.runAllTimersAsync();

    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith("card-2", "rejected");
  });
});
