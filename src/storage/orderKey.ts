import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

export const MAX_ORDER_KEY_LENGTH = 64;

export function orderKeyBetween(before: string | null, after: string | null): string {
  const key = generateKeyBetween(before, after);
  if (key.length > MAX_ORDER_KEY_LENGTH) throw new Error("Card order keys need an explicit rebalance");
  return key;
}

export function initialOrderKeys(count: number): string[] {
  return generateNKeysBetween(null, null, count);
}

export function compareOrdered<T extends { id: string; orderKey: string }>(a: T, b: T): number {
  return a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Explicit maintenance operation, never run implicitly during an ordinary move. */
export function rebalanceOrderKeys<T extends { id: string; orderKey: string }>(items: T[]): Map<string, string> {
  const ordered = [...items].sort(compareOrdered);
  const keys = initialOrderKeys(ordered.length);
  return new Map(ordered.map((item, index) => [item.id, keys[index]]));
}
