export function decayedMass(value: number, lastRefIso: string, now: Date): number {
  const last = Date.parse(lastRefIso);
  if (Number.isNaN(last)) return Math.max(0, value);
  const days = Math.floor((now.getTime() - last) / 86_400_000);
  return Math.max(0, value - Math.max(0, days));
}
