/**
 * Rope/catenary physics for canvas edge connections.
 * Simulates hanging cables with sag + spring bounce on connect/disconnect.
 *
 * Each edge gets a RopeState with sag (how much the curve droops)
 * and velocity for bounce animation. Settled ropes skip simulation.
 */

export interface RopeState {
  sag: number;       // current sag amount (pixels of droop at midpoint)
  velocity: number;  // sag velocity for bounce
  settled: boolean;  // skip tick when true
  targetSag: number; // equilibrium sag based on distance
}

// Physics constants
const STIFFNESS = 120;
const DAMPING = 18;
const SETTLE_THRESHOLD = 0.05;
const VELOCITY_THRESHOLD = 0.1;
const SAG_PER_PIXEL = 0.08;   // sag scales with distance
const MIN_SAG = 8;
const MAX_SAG = 60;

/** Global rope state map — keyed by edge ID */
const ropeStates = new Map<string, RopeState>();

/** Get or create rope state for an edge */
export function getRopeState(edgeId: string): RopeState {
  let state = ropeStates.get(edgeId);
  if (!state) {
    state = { sag: 0, velocity: 0, settled: false, targetSag: 20 };
    ropeStates.set(edgeId, state);
  }
  return state;
}

/** Remove rope state (edge deleted) */
export function removeRopeState(edgeId: string): void {
  ropeStates.delete(edgeId);
}

/** Trigger bounce animation (called when edge is created) */
export function bounceRope(edgeId: string, impulse = -300): void {
  const state = getRopeState(edgeId);
  state.velocity = impulse;
  state.settled = false;
}

/** Compute target sag based on distance between endpoints */
export function computeTargetSag(fromX: number, fromY: number, toX: number, toY: number): number {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  return Math.min(MAX_SAG, Math.max(MIN_SAG, dist * SAG_PER_PIXEL));
}

/** Tick all rope physics. Returns true if any rope is still animating. */
export function tickRopes(dt: number): boolean {
  let anyActive = false;
  const dtSec = Math.min(dt, 32) / 1000; // cap at 32ms, convert to seconds

  for (const state of ropeStates.values()) {
    if (state.settled) continue;
    anyActive = true;

    const displacement = state.sag - state.targetSag;
    const springForce = -STIFFNESS * displacement;
    const dampForce = -DAMPING * state.velocity;

    state.velocity += (springForce + dampForce) * dtSec;
    state.sag += state.velocity * dtSec;

    // Settle check
    if (
      Math.abs(state.sag - state.targetSag) < SETTLE_THRESHOLD &&
      Math.abs(state.velocity) < VELOCITY_THRESHOLD
    ) {
      state.sag = state.targetSag;
      state.velocity = 0;
      state.settled = true;
    }
  }

  return anyActive;
}

/**
 * Get catenary-like bezier control points for a rope edge.
 * Returns [cp1x, cp1y, cp2x, cp2y] for ctx.bezierCurveTo.
 */
export function getRopeControlPoints(
  fromX: number, fromY: number,
  toX: number, toY: number,
  sag: number,
): [number, number, number, number] {
  const midX = (fromX + toX) / 2;
  const dy = toY - fromY;
  const absDy = Math.abs(dy);

  // For vertical connections (typical workflow), sag pushes control points sideways
  // For horizontal, sag pushes downward
  const isMoreVertical = absDy > Math.abs(toX - fromX);

  if (isMoreVertical) {
    // Vertical flow: S-curve with sag influencing curvature depth
    const cpDist = Math.max(40, absDy * 0.4) + sag * 0.3;
    return [
      fromX, fromY + cpDist,
      toX, toY - cpDist,
    ];
  } else {
    // Horizontal flow: droop downward
    return [
      midX, fromY + sag,
      midX, toY + sag,
    ];
  }
}

/** Clean up states for edges that no longer exist */
export function pruneRopeStates(activeEdgeIds: Set<string>): void {
  for (const id of ropeStates.keys()) {
    if (!activeEdgeIds.has(id)) {
      ropeStates.delete(id);
    }
  }
}

/** Reset all rope states */
export function clearRopeStates(): void {
  ropeStates.clear();
}
