/**
 * Lightweight damped spring physics for UI animations.
 * No dependencies — pure math (damped harmonic oscillator).
 *
 * Usage:
 *   const s = createSpring(170, 26);  // stiffness, damping
 *   s.target = 1.05;                  // set target
 *   requestAnimationFrame(function loop(t) {
 *     s.tick(16);                     // advance ~16ms
 *     element.style.transform = `scale(${s.value})`;
 *     if (!s.settled) requestAnimationFrame(loop);
 *   });
 */

export interface Spring {
  value: number;
  velocity: number;
  target: number;
  settled: boolean;
  /** Advance simulation by dt milliseconds */
  tick(dt: number): void;
  /** Snap immediately to target */
  snap(): void;
  /** Kick with impulse velocity */
  kick(impulse: number): void;
}

const SETTLE_THRESHOLD = 0.001;
const VELOCITY_THRESHOLD = 0.01;

export function createSpring(
  stiffness = 170,
  damping = 26,
  initialValue = 0,
): Spring {
  const spring: Spring = {
    value: initialValue,
    velocity: 0,
    target: initialValue,
    settled: true,

    tick(dt: number) {
      if (spring.settled) return;
      // Sub-step for stability (max 4ms steps)
      const steps = Math.ceil(dt / 4);
      const stepDt = dt / steps / 1000; // seconds

      for (let i = 0; i < steps; i++) {
        const displacement = spring.value - spring.target;
        const springForce = -stiffness * displacement;
        const dampingForce = -damping * spring.velocity;
        const acceleration = springForce + dampingForce;

        spring.velocity += acceleration * stepDt;
        spring.value += spring.velocity * stepDt;
      }

      // Check if settled
      if (
        Math.abs(spring.value - spring.target) < SETTLE_THRESHOLD &&
        Math.abs(spring.velocity) < VELOCITY_THRESHOLD
      ) {
        spring.value = spring.target;
        spring.velocity = 0;
        spring.settled = true;
      }
    },

    snap() {
      spring.value = spring.target;
      spring.velocity = 0;
      spring.settled = true;
    },

    kick(impulse: number) {
      spring.velocity += impulse;
      spring.settled = false;
    },
  };

  return spring;
}

/** Convenience: set target and unsettle */
export function springTo(spring: Spring, target: number): void {
  if (spring.target === target && spring.settled) return;
  spring.target = target;
  spring.settled = false;
}
