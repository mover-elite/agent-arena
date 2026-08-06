import FakeTimers from "@sinonjs/fake-timers";

export interface ReplayClock {
  setTime(ms: number): void;
  uninstall(): void;
}

/** Install fake timers so strategy Date.now() tracks candle timestamps. */
export function installReplayClock(nowMs: number): ReplayClock {
  const clock = FakeTimers.install({
    now: nowMs,
    toFake: ["Date"],
  });
  return {
    setTime(ms: number) {
      clock.setSystemTime(ms);
    },
    uninstall() {
      clock.uninstall();
    },
  };
}
