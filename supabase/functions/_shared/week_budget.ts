/** Track newly compiled sessions separately from committed/actual weekly time. */
export class WeekBudget {
  private remaining = new Map<string, number>();
  private key(date: string): string {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
    return d.toISOString().slice(0, 10);
  }
  async available(date: string, load: () => Promise<number>): Promise<number> {
    const key = this.key(date);
    if (!this.remaining.has(key)) {
      const value = await load();
      if (!Number.isFinite(value) || value < 0) throw new Error("Invalid weekly time allowance");
      this.remaining.set(key, value);
    }
    return this.remaining.get(key)!;
  }
  consume(date: string, minutes: number): void {
    const key = this.key(date), available = this.remaining.get(key);
    if (available === undefined || !Number.isFinite(minutes) || minutes < 0 || minutes > available + 1e-6)
      throw new Error("Compiled session exceeds remaining weekly time");
    this.remaining.set(key, Math.max(0, available - minutes));
  }
}
