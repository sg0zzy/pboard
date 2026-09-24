import { useMemo, type CSSProperties } from "react";

const COLORS = ["#e05a47", "#3974c1", "#d29b25", "#4f8d5c", "#9a5ab5", "#df7f2d"];

type ConfettiParticle = {
  cluster: number | null;
  left: number;
  startY: number;
  middleY: number;
  endY: number;
  color: string;
  delay: number;
  duration: number;
  kick: number;
  drift: number;
  angle: number;
  middleAngle: number;
  finalAngle: number;
  width: number;
  height: number;
  round: boolean;
};

export type ConfettiBurst = {
  clusterCount: number;
  particles: ConfettiParticle[];
};

const between = (random: () => number, min: number, max: number) => min + random() * (max - min);
const integer = (random: () => number, min: number, max: number) => Math.floor(between(random, min, max + 1));
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function gaussian(random: () => number): number {
  const first = Math.max(random(), Number.EPSILON);
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function chooseClusterCenters(random: () => number, count: number): number[] {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const centers = Array.from({ length: count }, () => between(random, 7, 93)).sort((a, b) => a - b);
    const separated = centers.every((center, index) => index === 0 || center - centers[index - 1] >= 12);
    if (separated && centers.at(-1)! - centers[0] >= 48) return centers;
  }

  // Extremely unlikely fallback that keeps broad coverage without fixed positions.
  return Array.from({ length: count }, (_, index) =>
    clamp(((index + .5) / count) * 100 + between(random, -7, 7), 6, 94)
  );
}

export function generateConfettiBurst(random: () => number = Math.random): ConfettiBurst {
  const clusterCount = integer(random, 2, 4);
  const centers = chooseClusterCenters(random, clusterCount);
  const totalCount = integer(random, 36, 44);
  const outlierCount = integer(random, 4, 7);
  const clusteredCount = totalCount - outlierCount;
  const densityWeights = centers.map(() => between(random, .65, 1.45));
  const weightTotal = densityWeights.reduce((sum, weight) => sum + weight, 0);
  const counts = densityWeights.map((weight) => Math.max(5, Math.floor(clusteredCount * weight / weightTotal)));
  while (counts.reduce((sum, count) => sum + count, 0) < clusteredCount) counts[integer(random, 0, counts.length - 1)] += 1;
  while (counts.reduce((sum, count) => sum + count, 0) > clusteredCount) {
    const largest = counts.indexOf(Math.max(...counts));
    counts[largest] -= 1;
  }

  const particles: ConfettiParticle[] = [];
  centers.forEach((center, cluster) => {
    const centerY = between(random, -5, 7);
    const spreadX = between(random, 4.5, 10.5);
    const spreadY = between(random, 1.5, 4.5);
    const baseDrift = between(random, -52, 52);
    const baseEndY = between(random, 94, 116);
    const baseDuration = between(random, 730, 850);
    const baseDelay = between(random, 0, 65);
    const rotationDirection = random() < .5 ? -1 : 1;
    const baseRotation = rotationDirection * between(random, 300, 620);

    for (let index = 0; index < counts[cluster]; index += 1) {
      const startY = clamp(centerY + gaussian(random) * spreadY, -10, 15);
      const endY = clamp(baseEndY + gaussian(random) * 7, 84, 124);
      const drift = baseDrift + gaussian(random) * 17;
      const angle = between(random, -110, 110);
      const rotation = baseRotation + gaussian(random) * 135;
      particles.push({
        cluster,
        left: clamp(center + gaussian(random) * spreadX, .5, 99.5),
        startY,
        middleY: startY + (endY - startY) * between(random, .24, .36),
        endY,
        color: COLORS[integer(random, 0, COLORS.length - 1)],
        delay: clamp(baseDelay + gaussian(random) * 25, 0, 105),
        duration: clamp(baseDuration + gaussian(random) * 55, 700, 875),
        kick: baseDrift * .2 + gaussian(random) * 9,
        drift,
        angle,
        middleAngle: angle + rotation * between(random, .28, .44),
        finalAngle: angle + rotation,
        width: between(random, 3.5, 7),
        height: between(random, 5.5, 11),
        round: random() < .16
      });
    }
  });

  for (let index = 0; index < outlierCount; index += 1) {
    const startY = between(random, -10, 16);
    const endY = between(random, 86, 122);
    const angle = between(random, -140, 140);
    const rotation = between(random, -720, 720);
    particles.push({
      cluster: null,
      left: between(random, 1, 99),
      startY,
      middleY: startY + (endY - startY) * between(random, .2, .38),
      endY,
      color: COLORS[integer(random, 0, COLORS.length - 1)],
      delay: between(random, 0, 105),
      duration: between(random, 700, 875),
      kick: between(random, -18, 18),
      drift: between(random, -75, 75),
      angle,
      middleAngle: angle + rotation * between(random, .25, .45),
      finalAngle: angle + rotation,
      width: between(random, 3.5, 7),
      height: between(random, 5.5, 11),
      round: random() < .16
    });
  }

  return { clusterCount, particles };
}

export function BoardConfetti({ revision }: { revision: number }) {
  const burst = useMemo(() => generateConfettiBurst(), [revision]);
  return (
    <div className="board-confetti" aria-hidden="true">
      {burst.particles.map((particle, index) => (
        <i
          key={index}
          className={`board-confetti-piece${particle.round ? " board-confetti-piece--round" : ""}`}
          style={{
            left: `${particle.left}%`,
            width: `${particle.width}px`,
            height: `${particle.height}px`,
            "--confetti-color": particle.color,
            "--confetti-start-y": `${particle.startY}%`,
            "--confetti-middle-y": `${particle.middleY}%`,
            "--confetti-end-y": `${particle.endY}%`,
            "--confetti-delay": `${particle.delay}ms`,
            "--confetti-duration": `${particle.duration}ms`,
            "--confetti-kick": `${particle.kick}px`,
            "--confetti-drift": `${particle.drift}px`,
            "--confetti-angle": `${particle.angle}deg`,
            "--confetti-middle-angle": `${particle.middleAngle}deg`,
            "--confetti-final-angle": `${particle.finalAngle}deg`
          } as CSSProperties}
        />
      ))}
    </div>
  );
}
