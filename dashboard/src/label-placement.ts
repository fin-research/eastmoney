export interface LabelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LabelLineSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type VerticalPreference = "top" | "bottom";

interface LabelPlacementInput {
  point: { x: number; y: number };
  label: { width: number; height: number };
  bounds: LabelRect;
  obstacles: LabelRect[];
  preferred: VerticalPreference;
  gap?: number;
  collisionPadding?: number;
  lineObstacles?: LabelLineSegment[];
  linePadding?: number;
}

export interface LabelPlacement extends LabelRect {
  side: "top" | "bottom" | "left" | "right";
}

export function chooseBestLabelPlacement({
  point,
  label,
  bounds,
  obstacles,
  preferred,
  gap = 14,
  collisionPadding = 4,
  lineObstacles = [],
  linePadding = 4,
}: LabelPlacementInput): LabelPlacement {
  const halfWidth = label.width / 2;
  const halfHeight = label.height / 2;
  const anchoredCandidates: LabelPlacement[] = [
    {
      x: point.x - halfWidth,
      y: point.y - gap - label.height,
      ...label,
      side: "top",
    },
    {
      x: point.x - halfWidth,
      y: point.y + gap,
      ...label,
      side: "bottom",
    },
    {
      x: point.x - label.width,
      y: point.y - gap - label.height,
      ...label,
      side: "top",
    },
    {
      x: point.x,
      y: point.y - gap - label.height,
      ...label,
      side: "top",
    },
    {
      x: point.x - label.width,
      y: point.y + gap,
      ...label,
      side: "bottom",
    },
    {
      x: point.x,
      y: point.y + gap,
      ...label,
      side: "bottom",
    },
    {
      x: point.x - gap - label.width,
      y: point.y - halfHeight,
      ...label,
      side: "left",
    },
    {
      x: point.x + gap,
      y: point.y - halfHeight,
      ...label,
      side: "right",
    },
  ];

  const candidates = uniquePlacements([
    ...anchoredCandidates.map((candidate) =>
      clampPlacement(candidate, bounds),
    ),
    ...searchPlacements(point, label, bounds),
  ]);
  const paddedObstacles = [
    ...obstacles.map((obstacle) => inflateRect(obstacle, collisionPadding)),
    {
      x: point.x - gap / 2,
      y: point.y - gap / 2,
      width: gap,
      height: gap,
    },
  ];

  return candidates.reduce((best, candidate, order) => {
    const score = placementScore(
      candidate,
      bounds,
      paddedObstacles,
      lineObstacles,
      linePadding,
      preferred,
      point,
      order,
    );
    return score < best.score ? { placement: candidate, score } : best;
  }, {
    placement: candidates[0]!,
    score: Number.POSITIVE_INFINITY,
  }).placement;
}

function clampPlacement(
  placement: LabelPlacement,
  bounds: LabelRect,
): LabelPlacement {
  const maximumX = Math.max(
    bounds.x,
    bounds.x + bounds.width - placement.width,
  );
  const maximumY = Math.max(
    bounds.y,
    bounds.y + bounds.height - placement.height,
  );
  return {
    ...placement,
    x: Math.min(maximumX, Math.max(bounds.x, placement.x)),
    y: Math.min(maximumY, Math.max(bounds.y, placement.y)),
  };
}

function searchPlacements(
  point: { x: number; y: number },
  label: { width: number; height: number },
  bounds: LabelRect,
): LabelPlacement[] {
  const maximumX = Math.max(bounds.x, bounds.x + bounds.width - label.width);
  const maximumY = Math.max(bounds.y, bounds.y + bounds.height - label.height);
  const step = Math.max(
    4,
    Math.min(8, Math.round(Math.min(label.width, label.height) / 5)),
  );
  const xs = scanPositions(bounds.x, maximumX, step);
  const ys = scanPositions(bounds.y, maximumY, step);
  const placements: LabelPlacement[] = [];

  for (const y of ys) {
    for (const x of xs) {
      placements.push({
        x,
        y,
        ...label,
        side: inferSide(point, { x, y, ...label }),
      });
    }
  }
  return placements;
}

function scanPositions(start: number, end: number, step: number): number[] {
  if (end <= start) return [start];
  const positions: number[] = [];
  for (let value = start; value < end; value += step) positions.push(value);
  positions.push(end);
  return positions;
}

function inferSide(
  point: { x: number; y: number },
  label: LabelRect,
): LabelPlacement["side"] {
  const dx = label.x + label.width / 2 - point.x;
  const dy = label.y + label.height / 2 - point.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? "left" : "right";
  return dy < 0 ? "top" : "bottom";
}

function uniquePlacements(placements: LabelPlacement[]): LabelPlacement[] {
  const seen = new Set<string>();
  return placements.filter((placement) => {
    const key = `${placement.x.toFixed(2)}:${placement.y.toFixed(2)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inflateRect(rect: LabelRect, padding: number): LabelRect {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  };
}

function placementScore(
  candidate: LabelPlacement,
  bounds: LabelRect,
  obstacles: LabelRect[],
  lineObstacles: LabelLineSegment[],
  linePadding: number,
  preferred: VerticalPreference,
  point: { x: number; y: number },
  order: number,
): number {
  const outside =
    Math.max(0, bounds.x - candidate.x) +
    Math.max(0, bounds.y - candidate.y) +
    Math.max(
      0,
      candidate.x + candidate.width - (bounds.x + bounds.width),
    ) +
    Math.max(
      0,
      candidate.y + candidate.height - (bounds.y + bounds.height),
    );
  const overlap = obstacles.reduce(
    (sum, obstacle) => sum + overlapArea(candidate, obstacle),
    0,
  );
  const lineIntersections = lineObstacles.reduce(
    (count, line) =>
      count +
      (segmentIntersectsRect(line, inflateRect(candidate, linePadding))
        ? 1
        : 0),
    0,
  );
  const verticalPenalty =
    candidate.side === preferred
      ? 0
      : candidate.side === "left" || candidate.side === "right"
        ? 400
        : 250;
  const distancePenalty = Math.hypot(
    candidate.x + candidate.width / 2 - point.x,
    candidate.y + candidate.height / 2 - point.y,
  );

  return (
    outside * 1_000_000_000 +
    lineIntersections * 100_000_000 +
    overlap * 1_000_000 +
    verticalPenalty +
    distancePenalty +
    order / 10_000
  );
}

export function segmentIntersectsRect(
  line: LabelLineSegment,
  rect: LabelRect,
): boolean {
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;
  let tMinimum = 0;
  let tMaximum = 1;
  const dx = line.x2 - line.x1;
  const dy = line.y2 - line.y1;
  const boundaries: Array<[number, number]> = [
    [-dx, line.x1 - left],
    [dx, right - line.x1],
    [-dy, line.y1 - top],
    [dy, bottom - line.y1],
  ];

  for (const [direction, distance] of boundaries) {
    if (direction === 0) {
      if (distance < 0) return false;
      continue;
    }
    const ratio = distance / direction;
    if (direction < 0) tMinimum = Math.max(tMinimum, ratio);
    else tMaximum = Math.min(tMaximum, ratio);
    if (tMinimum > tMaximum) return false;
  }
  return true;
}

export function overlapArea(left: LabelRect, right: LabelRect): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y),
  );
  return width * height;
}
