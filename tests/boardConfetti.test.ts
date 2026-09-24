import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BoardConfetti, generateConfettiBurst } from "../src/sidebar/components/BoardConfetti";

function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

describe("board confetti", () => {
  it("renders a moderate, layout-free board overlay", () => {
    const markup = renderToStaticMarkup(createElement(BoardConfetti, { revision: 1 }));
    expect(markup).toContain("board-confetti");
    expect(markup.match(/class="board-confetti-piece/g)?.length).toBeGreaterThanOrEqual(36);
    expect(markup.match(/class="board-confetti-piece/g)?.length).toBeLessThanOrEqual(44);
    expect(markup).toContain('aria-hidden="true"');
  });

  it("creates bounded clusters, irregular outliers, and a new layout for each burst", () => {
    const first = generateConfettiBurst(seededRandom(17));
    const second = generateConfettiBurst(seededRandom(29));
    const outliers = first.particles.filter((particle) => particle.cluster === null);
    const clusterIds = new Set(first.particles.flatMap((particle) => particle.cluster === null ? [] : [particle.cluster]));

    expect(first.clusterCount).toBeGreaterThanOrEqual(2);
    expect(first.clusterCount).toBeLessThanOrEqual(4);
    expect(clusterIds.size).toBe(first.clusterCount);
    expect(first.particles.length).toBeGreaterThanOrEqual(36);
    expect(first.particles.length).toBeLessThanOrEqual(44);
    expect(outliers.length).toBeGreaterThanOrEqual(4);
    expect(outliers.length).toBeLessThanOrEqual(7);
    expect(first.particles.every((particle) => particle.left >= .5 && particle.left <= 99.5)).toBe(true);
    expect(first.particles.every((particle) => particle.delay + particle.duration <= 980)).toBe(true);
    expect(first.particles.map((particle) => particle.left)).not.toEqual(second.particles.map((particle) => particle.left));
  });
});
