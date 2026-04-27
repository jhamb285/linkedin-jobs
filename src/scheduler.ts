import type { AppConfig, ActionType } from "./types";
import type { Store } from "./store";
import { getDailyLimit, randomDelay } from "./config";

export class RateLimiter {
  constructor(
    private config: AppConfig,
    private store: Store
  ) {}

  canPerform(action: ActionType): boolean {
    const today = this.store.getTodayCount(action);

    switch (action) {
      case "comment":
        return today < getDailyLimit(this.config);
      case "connection":
        return today < this.config.maxConnectionsPerDay;
      case "dm":
        return today < this.config.maxDmsPerDay;
      default:
        return false;
    }
  }

  getRemainingToday(action: ActionType): number {
    const today = this.store.getTodayCount(action);

    switch (action) {
      case "comment":
        return Math.max(0, getDailyLimit(this.config) - today);
      case "connection":
        return Math.max(0, this.config.maxConnectionsPerDay - today);
      case "dm":
        return Math.max(0, this.config.maxDmsPerDay - today);
      default:
        return 0;
    }
  }

  async waitBeforeNext(): Promise<void> {
    const delay = randomDelay(
      this.config.commentDelayMinMs,
      this.config.commentDelayMaxMs
    );
    console.log(`  [rate-limit] Waiting ${Math.round(delay / 60000)}m...`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
