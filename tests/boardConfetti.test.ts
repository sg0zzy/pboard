import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

describe("confetti animation cost", () => {
  // The fall must stay a compositor animation. Animating `top` here laid out the
  // whole board every frame: measured on the shipped CSS with 45 real particles,
  // `LayoutCount` went 59 → 2 and main-thread `TaskDuration` 72 ms → 30 ms per
  // burst once the path became transform-only. A re-introduced layout property
  // in these keyframes shows up as a sluggish sidebar on a normal machine, so
  // the rule is asserted rather than left to review.
  const css = readFileSync(join(import.meta.dirname, "../src/sidebar/styles/index.css"), "utf8");
  const block = (start: string): string => {
    const from = css.indexOf(start);
    expect(from).toBeGreaterThanOrEqual(0);
    const open = css.indexOf("{", from);
    let depth = 0;
    for (let index = open; index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}") {
        depth -= 1;
        if (depth === 0) return css.slice(open + 1, index);
      }
    }
    throw new Error(`unterminated block: ${start}`);
  };
  const LAYOUT_PROPERTIES = ["top", "left", "right", "bottom", "width", "height", "margin", "padding", "inset", "transform-origin"];

  it("animates only compositor properties", () => {
    const animated = new Set<string>();
    // Every declaration inside the keyframes, across all its offsets.
    for (const match of block("@keyframes board-confetti-fall").matchAll(/([a-z-]+)\s*:/g)) animated.add(match[1]);
    expect([...animated].filter((name) => LAYOUT_PROPERTIES.includes(name))).toEqual([]);
    expect([...animated].sort()).toEqual(["opacity", "transform"]);
  });

  it("positions particles from a static origin", () => {
    const piece = block(".board-confetti-piece ");
    // The vertical path is expressed as `translate` against a fixed `top: 0`;
    // a `top: var(...)` would reintroduce the per-frame layout.
    expect(piece).toMatch(/(^|[\s;{])top:\s*0(px|;|\s)/);
    expect(piece).not.toMatch(/top:\s*var\(/);
    // `translateY(%)` would resolve against the piece's own height (a few px),
    // not the board: the container-relative unit is what preserves geometry.
    expect(block(".board-confetti ")).toContain("container-type: size");
    // The particle's Y offsets must be emitted in container units; a `%` there
    // (or a `translateY(…)` percentage) silently changes the whole path.
    const markup = renderToStaticMarkup(createElement(BoardConfetti, { revision: 3 }));
    expect(markup).toMatch(/--confetti-start-y:\s*[-\d.]+cqh/);
    expect(markup).toMatch(/--confetti-end-y:\s*[-\d.]+cqh/);
    expect(markup).not.toMatch(/--confetti-(start|middle|end)-y:\s*[\d.]+%/);
  });
});
