/**
 * physarumSim.ts — Physarum polycephalum (slime mold) pixel simulation.
 * Multi-species agents crawl on a pixel trail map, leaving pheromone deposits.
 * BLOB nodes act as food sources that attract agents.
 * Creates organic colored veins connecting nodes with directional flow particles.
 *
 * Species:
 *   - arterial (40%): thick main veins, slow turn, strong deposit
 *   - capillary (45%): thin branching networks, fast turn, light deposit
 *   - scout (15%): explores dark areas (inverted sense), long sensor range
 */

export type AgentSpecies = "arterial" | "capillary" | "scout";

export interface PhysarumAgent {
  x: number;
  y: number;
  angle: number;
  species: AgentSpecies;
}

export interface FoodSource {
  x: number;
  y: number;
  radius: number;
  strength: number;
  r: number; g: number; b: number;
}

/** A vein path between two food sources — deposits pheromone along the line */
export interface VeinPath {
  x1: number; y1: number;
  x2: number; y2: number;
  strength: number;
  r: number; g: number; b: number;
  /** True when either endpoint node is running/thinking */
  active?: boolean;
}

export interface PhysarumConfig {
  agentCount: number;
  sensorAngle: number;    // radians — angle offset for left/right sensors
  sensorDist: number;     // pixels — how far ahead to sense
  turnSpeed: number;      // radians — max turn per step
  stepSize: number;       // pixels — movement per frame
  depositAmount: number;  // how much pheromone to deposit
  decayRate: number;      // 0-1 — trail fade per frame
  diffuseRate: number;    // 0-1 — how much to blur/spread
}

export const DEFAULT_CONFIG: PhysarumConfig = {
  agentCount: 2000,
  sensorAngle: Math.PI / 5,
  sensorDist: 14,
  turnSpeed: Math.PI / 6,
  stepSize: 1.0,
  depositAmount: 3,
  decayRate: 0.94,       // faster decay = cleaner trails
  diffuseRate: 0.08,     // minimal blur = sharp veins
};

// ─── Species-specific parameters ────────────────────────────────────────────

interface SpeciesParams {
  depositAmount: number;
  turnSpeed: number;
  sensorDist: number;
}

const SPECIES_PARAMS: Record<AgentSpecies, SpeciesParams> = {
  arterial:  { depositAmount: 3, turnSpeed: Math.PI / 6,  sensorDist: 14 },
  capillary: { depositAmount: 1, turnSpeed: Math.PI / 4,  sensorDist: 8 },
  scout:     { depositAmount: 0.3, turnSpeed: Math.PI / 3,  sensorDist: 20 },
};

// ─── Internal types ─────────────────────────────────────────────────────────

/** A flow particle that travels along an active vein */
interface FlowParticle {
  x: number;
  y: number;
  progress: number;   // 0-1 position along the vein
  speed: number;
  veinIdx: number;
  r: number; g: number; b: number;
}

/** An expanding pheromone pulse ring */
interface Pulse {
  x: number;
  y: number;
  strength: number;
  r: number; g: number; b: number;
  currentRadius: number;
  maxRadius: number;
  frame: number;
  maxFrames: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_FLOW_PARTICLES = 50;
const MAX_PULSES = 10;
const PARTICLES_PER_VEIN = 5;
const PULSE_FRAMES = 30;
const SCOUT_TENDRIL_DIST_SQ = 100 * 100; // 100px threshold for tendril deposit
const NEAR_FOOD_SQ = 80 * 80;
const FAR_FOOD_SQ = 200 * 200;

// ─── Simulation class ───────────────────────────────────────────────────────

export class PhysarumSimulation {
  width: number;
  height: number;
  agents: PhysarumAgent[];
  trailMap: Float32Array;
  colorMap: Uint8ClampedArray;
  config: PhysarumConfig;
  foodSources: FoodSource[];
  veinPaths: VeinPath[];

  private flowParticles: FlowParticle[] = [];
  private pulses: Pulse[] = [];
  private tmpTrailMap: Float32Array;

  constructor(width: number, height: number, config = DEFAULT_CONFIG) {
    this.width = width;
    this.height = height;
    this.config = config;
    this.trailMap = new Float32Array(width * height);
    this.tmpTrailMap = new Float32Array(width * height);
    this.colorMap = new Uint8ClampedArray(width * height * 3);
    this.agents = [];
    this.foodSources = [];
    this.veinPaths = [];
    this.initAgents();
  }

  // ─── Agent initialization (multi-species) ─────────────────────────────

  private initAgents() {
    this.agents = [];
    const total = this.config.agentCount;
    const arterialCount = Math.round(total * 0.75);    // ~1500 — main veins
    const capillaryCount = Math.round(total * 0.25);   // ~500 — subtle fill
    const scoutCount = 0;                               // disabled — too noisy

    const w = this.width, h = this.height;

    const spawn = (species: AgentSpecies): PhysarumAgent => {
      let x: number, y: number;
      if (this.foodSources.length > 0) {
        const food = this.foodSources[Math.floor(Math.random() * this.foodSources.length)];
        const a = Math.random() * Math.PI * 2;
        const d = Math.random() * food.radius * 4;
        x = food.x + Math.cos(a) * d;
        y = food.y + Math.sin(a) * d;
      } else {
        const cx = w / 2, cy = h / 2;
        const a = Math.random() * Math.PI * 2;
        const d = Math.random() * 60;
        x = cx + Math.cos(a) * d;
        y = cy + Math.sin(a) * d;
      }
      x = Math.max(1, Math.min(w - 2, x));
      y = Math.max(1, Math.min(h - 2, y));
      return { x, y, angle: Math.random() * Math.PI * 2, species };
    };

    for (let i = 0; i < arterialCount; i++) this.agents.push(spawn("arterial"));
    for (let i = 0; i < capillaryCount; i++) this.agents.push(spawn("capillary"));
    for (let i = 0; i < scoutCount; i++) this.agents.push(spawn("scout"));
  }

  // ─── Public methods (same signatures) ─────────────────────────────────

  resize(width: number, height: number) {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.trailMap = new Float32Array(width * height);
    this.tmpTrailMap = new Float32Array(width * height);
    this.colorMap = new Uint8ClampedArray(width * height * 3);
    this.initAgents();
  }

  setFoodSources(sources: FoodSource[]) {
    const hadSources = this.foodSources.length;
    this.foodSources = sources;
    if (sources.length > 0 && (hadSources === 0 || Math.abs(sources.length - hadSources) > 2)) {
      this.initAgents();
    }
  }

  setVeinPaths(paths: VeinPath[]) {
    this.veinPaths = paths;
  }

  /** Trigger an expanding pheromone pulse ring at a position (called by blobRenderer on step complete) */
  triggerPulse(x: number, y: number, radius: number, strength: number, r: number, g: number, b: number) {
    if (this.pulses.length >= MAX_PULSES) {
      this.pulses.shift();
    }
    this.pulses.push({
      x, y, strength, r, g, b,
      currentRadius: 0,
      maxRadius: radius,
      frame: 0,
      maxFrames: PULSE_FRAMES,
    });
  }

  // ─── Sensing (species-aware sensor distance) ──────────────────────────

  private sense(agent: PhysarumAgent, angleOffset: number, sensorDist: number): number {
    const sAngle = agent.angle + angleOffset;
    const sx = Math.round(agent.x + Math.cos(sAngle) * sensorDist);
    const sy = Math.round(agent.y + Math.sin(sAngle) * sensorDist);
    if (sx < 0 || sx >= this.width || sy < 0 || sy >= this.height) return 0;
    return this.trailMap[sy * this.width + sx];
  }

  // ─── Nearest food source helper ───────────────────────────────────────

  private nearestFood(x: number, y: number): { food: FoodSource; distSq: number } | null {
    if (this.foodSources.length === 0) return null;
    let best = this.foodSources[0];
    let bestD = (x - best.x) ** 2 + (y - best.y) ** 2;
    for (let i = 1; i < this.foodSources.length; i++) {
      const f = this.foodSources[i];
      const d = (x - f.x) ** 2 + (y - f.y) ** 2;
      if (d < bestD) { bestD = d; best = f; }
    }
    return { food: best, distSq: bestD };
  }

  // ─── Main tick ────────────────────────────────────────────────────────

  tick() {
    const { stepSize, sensorAngle } = this.config;
    const w = this.width, h = this.height;

    // ─── Deposit vein pheromone along edges ───────────────────────
    const now = performance.now();
    for (const vein of this.veinPaths) {
      const vdx = vein.x2 - vein.x1, vdy = vein.y2 - vein.y1;
      const dist = Math.sqrt(vdx * vdx + vdy * vdy);
      if (dist < 2) continue;
      const steps = Math.ceil(dist / 1.5);
      const perpX = -vdy / dist, perpY = vdx / dist;

      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const distFactor = Math.min(dist / 200, 1);
        // Thin veins: 2px close, 5px far — not 13px
        const maxThick = Math.round(2 + distFactor * 3);
        const minThick = 1;
        const thinning = Math.sin(t * Math.PI); // 0 at ends, 1 at middle
        const thickness = Math.max(minThick, Math.round(maxThick - thinning * (maxThick - minThick)));

        // Minimal wobble — organic but not chaotic
        const wobbleAmt = thinning * (0.5 + distFactor * 1);
        const wobble = Math.sin(t * Math.PI * 2 + now * 0.0002) * wobbleAmt;

        let cx = vein.x1 + vdx * t + perpX * wobble;
        let cy = vein.y1 + vdy * t + perpY * wobble;

        // ─── Branch repulsion: push deposit away from foreign-color pheromone ──
        const checkR = thickness + 4;
        const ix = Math.round(cx), iy = Math.round(cy);
        if (ix >= checkR && ix < w - checkR && iy >= checkR && iy < h - checkR) {
          let pushX = 0, pushY = 0;
          // Sample 4 cardinal directions for foreign color
          const cardinals: [number, number][] = [[checkR, 0], [-checkR, 0], [0, checkR], [0, -checkR]];
          for (const [ox, oy] of cardinals) {
            const si = (iy + oy) * w + (ix + ox);
            const trail = this.trailMap[si];
            if (trail > 20) {
              const ci3 = si * 3;
              const dr = Math.abs(this.colorMap[ci3] - vein.r);
              const dg = Math.abs(this.colorMap[ci3 + 1] - vein.g);
              const db = Math.abs(this.colorMap[ci3 + 2] - vein.b);
              if (dr + dg + db > 60) {
                // Foreign color — push away from it
                pushX -= ox * trail * 0.003;
                pushY -= oy * trail * 0.003;
              }
            }
          }
          cx += pushX;
          cy += pushY;
        }

        const str = vein.strength * (0.3 + distFactor * 0.7) * (1 + (1 - thinning) * 0.3);
        for (let oy = -thickness; oy <= thickness; oy++) {
          for (let ox = -thickness; ox <= thickness; ox++) {
            if (ox * ox + oy * oy > thickness * thickness) continue;
            const fx = Math.round(cx + ox), fy = Math.round(cy + oy);
            if (fx < 0 || fx >= w || fy < 0 || fy >= h) continue;
            const idx = fy * w + fx;
            const edgeFade = 1 - Math.sqrt(ox * ox + oy * oy) / (thickness + 1);
            this.trailMap[idx] = Math.min(255, this.trailMap[idx] + str * edgeFade);
            const cidx = idx * 3;
            this.colorMap[cidx] = Math.round(this.colorMap[cidx] * 0.7 + vein.r * 0.3);
            this.colorMap[cidx + 1] = Math.round(this.colorMap[cidx + 1] * 0.7 + vein.g * 0.3);
            this.colorMap[cidx + 2] = Math.round(this.colorMap[cidx + 2] * 0.7 + vein.b * 0.3);
          }
        }
      }
    }

    // ─── Deposit food source pheromone ────────────────────────────
    for (const food of this.foodSources) {
      const r2 = food.radius * food.radius;
      const minX = Math.max(0, Math.floor(food.x - food.radius));
      const maxX = Math.min(w - 1, Math.ceil(food.x + food.radius));
      const minY = Math.max(0, Math.floor(food.y - food.radius));
      const maxY = Math.min(h - 1, Math.ceil(food.y + food.radius));
      for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
          const fdx = px - food.x, fdy = py - food.y;
          if (fdx * fdx + fdy * fdy < r2) {
            const idx = py * w + px;
            this.trailMap[idx] = Math.min(255, this.trailMap[idx] + food.strength);
            const cidx = idx * 3;
            this.colorMap[cidx] = food.r;
            this.colorMap[cidx + 1] = food.g;
            this.colorMap[cidx + 2] = food.b;
          }
        }
      }
    }

    // ─── Update pulses (expanding rings) ─────────────────────────
    for (let pi = this.pulses.length - 1; pi >= 0; pi--) {
      const pulse = this.pulses[pi];
      pulse.frame++;
      if (pulse.frame > pulse.maxFrames) {
        this.pulses.splice(pi, 1);
        continue;
      }
      const progress = pulse.frame / pulse.maxFrames;
      const ringRadius = pulse.maxRadius * progress;
      const ringWidth = Math.max(2, pulse.maxRadius * 0.15);
      const fadeStr = pulse.strength * (1 - progress);

      // Deposit pheromone in a ring (sample points along circumference)
      const circumference = Math.max(8, Math.round(2 * Math.PI * ringRadius));
      const aStep = (Math.PI * 2) / circumference;
      for (let a = 0; a < Math.PI * 2; a += aStep) {
        for (let rOff = -ringWidth; rOff <= ringWidth; rOff += 1.5) {
          const r = ringRadius + rOff;
          const rpx = Math.round(pulse.x + Math.cos(a) * r);
          const rpy = Math.round(pulse.y + Math.sin(a) * r);
          if (rpx < 0 || rpx >= w || rpy < 0 || rpy >= h) continue;
          const idx = rpy * w + rpx;
          const edgeFade = 1 - Math.abs(rOff) / (ringWidth + 1);
          this.trailMap[idx] = Math.min(255, this.trailMap[idx] + fadeStr * edgeFade);
          const cidx = idx * 3;
          this.colorMap[cidx] = Math.round(this.colorMap[cidx] * 0.6 + pulse.r * 0.4);
          this.colorMap[cidx + 1] = Math.round(this.colorMap[cidx + 1] * 0.6 + pulse.g * 0.4);
          this.colorMap[cidx + 2] = Math.round(this.colorMap[cidx + 2] * 0.6 + pulse.b * 0.4);
        }
      }
    }

    // ─── Update flow particles ───────────────────────────────────
    this.tickFlowParticles();

    // ─── Update agents (multi-species) ───────────────────────────
    for (const agent of this.agents) {
      const sp = SPECIES_PARAMS[agent.species];
      const turnSpeed = sp.turnSpeed;
      const sensorDist = sp.sensorDist;
      const depositAmt = sp.depositAmount;

      // Sense
      const fwd = this.sense(agent, 0, sensorDist);
      const left = this.sense(agent, -sensorAngle, sensorDist);
      const right = this.sense(agent, sensorAngle, sensorDist);

      if (agent.species === "scout") {
        // Scout: INVERTED sense — seek LOW pheromone (turn toward darkness)
        const ifwd = 255 - fwd;
        const ileft = 255 - left;
        const iright = 255 - right;

        if (ifwd >= ileft && ifwd >= iright) {
          agent.angle += (Math.random() - 0.5) * turnSpeed * 0.1;
        } else if (ileft > iright) {
          agent.angle -= turnSpeed * (0.5 + Math.random() * 0.5);
        } else if (iright > ileft) {
          agent.angle += turnSpeed * (0.5 + Math.random() * 0.5);
        } else {
          agent.angle += (Math.random() - 0.5) * turnSpeed;
        }
      } else {
        // Arterial / Capillary: normal sense (seek high pheromone)
        if (fwd >= left && fwd >= right) {
          agent.angle += (Math.random() - 0.5) * turnSpeed * 0.1;
        } else if (left > right) {
          agent.angle -= turnSpeed * (0.5 + Math.random() * 0.5);
        } else if (right > left) {
          agent.angle += turnSpeed * (0.5 + Math.random() * 0.5);
        } else {
          agent.angle += (Math.random() - 0.5) * turnSpeed;
        }
      }

      // Move
      const nx = agent.x + Math.cos(agent.angle) * stepSize;
      const ny = agent.y + Math.sin(agent.angle) * stepSize;
      const outOfBounds = nx < 0 || nx >= w || ny < 0 || ny >= h;

      if (outOfBounds) {
        // All species respawn near food sources when hitting edge
        if (this.foodSources.length > 0) {
          const food = this.foodSources[Math.floor(Math.random() * this.foodSources.length)];
          const a = Math.random() * Math.PI * 2;
          agent.x = Math.max(1, Math.min(w - 2, food.x + Math.cos(a) * food.radius * 3));
          agent.y = Math.max(1, Math.min(h - 2, food.y + Math.sin(a) * food.radius * 3));
          agent.angle = Math.random() * Math.PI * 2;
        } else {
          agent.x = Math.max(1, Math.min(w - 2, nx));
          agent.y = Math.max(1, Math.min(h - 2, ny));
          agent.angle = Math.random() * Math.PI * 2;
        }
      } else {
        // Starving check for non-scout agents only
        const starving = agent.species !== "scout"
          && this.foodSources.length > 0
          && this.trailMap[Math.round(ny) * w + Math.round(nx)] < 0.1;

        if (starving && Math.random() < 0.05) {
          const food = this.foodSources[Math.floor(Math.random() * this.foodSources.length)];
          const a = Math.random() * Math.PI * 2;
          agent.x = Math.max(1, Math.min(w - 2, food.x + Math.cos(a) * food.radius * 3));
          agent.y = Math.max(1, Math.min(h - 2, food.y + Math.sin(a) * food.radius * 3));
          agent.angle = Math.random() * Math.PI * 2;
        } else {
          agent.x = nx;
          agent.y = ny;
        }
      }

      // ─── Deposit pheromone ─────────────────────────────────────
      const px = Math.round(agent.x);
      const py = Math.round(agent.y);
      if (px >= 0 && px < w && py >= 0 && py < h) {
        const idx = py * w + px;

        // Scout bonus (disabled when scout count = 0)
        let actualDeposit = depositAmt;
        if (agent.species === "scout" && this.trailMap[idx] < 1) {
          const nf = this.nearestFood(agent.x, agent.y);
          if (!nf || nf.distSq > SCOUT_TENDRIL_DIST_SQ) {
            actualDeposit = depositAmt * 2;
          }
        }

        this.trailMap[idx] = Math.min(255, this.trailMap[idx] + actualDeposit);

        // ─── Color deposit based on species + nearest food ─────
        if (this.foodSources.length > 0) {
          const nf = this.nearestFood(agent.x, agent.y);
          if (nf) {
            const cidx = idx * 3;
            const fr = nf.food.r, fg = nf.food.g, fb = nf.food.b;

            if (agent.species === "arterial") {
              // Arterial: direct blend toward nearest food color
              this.colorMap[cidx]     = Math.round(this.colorMap[cidx]     * 0.9 + fr * 0.1);
              this.colorMap[cidx + 1] = Math.round(this.colorMap[cidx + 1] * 0.9 + fg * 0.1);
              this.colorMap[cidx + 2] = Math.round(this.colorMap[cidx + 2] * 0.9 + fb * 0.1);
            } else if (agent.species === "capillary") {
              // Capillary: 50% food color + 50% desaturated version
              const avg = (fr + fg + fb) / 3;
              const dr = Math.round(fr * 0.5 + avg * 0.5);
              const dg = Math.round(fg * 0.5 + avg * 0.5);
              const db = Math.round(fb * 0.5 + avg * 0.5);
              this.colorMap[cidx]     = Math.round(this.colorMap[cidx]     * 0.9 + dr * 0.1);
              this.colorMap[cidx + 1] = Math.round(this.colorMap[cidx + 1] * 0.9 + dg * 0.1);
              this.colorMap[cidx + 2] = Math.round(this.colorMap[cidx + 2] * 0.9 + db * 0.1);
            } else {
              // Scout: very faint — 20% food color + 80% transparent
              const sr = Math.round(fr * 0.2);
              const sg = Math.round(fg * 0.2);
              const sb = Math.round(fb * 0.2);
              this.colorMap[cidx]     = Math.round(this.colorMap[cidx]     * 0.95 + sr * 0.05);
              this.colorMap[cidx + 1] = Math.round(this.colorMap[cidx + 1] * 0.95 + sg * 0.05);
              this.colorMap[cidx + 2] = Math.round(this.colorMap[cidx + 2] * 0.95 + sb * 0.05);
            }
          }
        }
      }
    }

    // ─── Diffuse + Decay trail map (adaptive network) ────────────
    this.diffuseAndDecay();
  }

  // ─── Flow particles ───────────────────────────────────────────────────

  private tickFlowParticles() {
    const w = this.width, h = this.height;

    // Spawn particles for active veins
    for (let vi = 0; vi < this.veinPaths.length; vi++) {
      const vein = this.veinPaths[vi];
      if (!vein.active) continue;

      // Count existing particles for this vein
      let count = 0;
      for (const p of this.flowParticles) {
        if (p.veinIdx === vi) count++;
      }

      // Spawn up to PARTICLES_PER_VEIN, respecting global cap
      while (count < PARTICLES_PER_VEIN && this.flowParticles.length < MAX_FLOW_PARTICLES) {
        this.flowParticles.push({
          x: vein.x1,
          y: vein.y1,
          progress: Math.random() * 0.3, // stagger start
          speed: 0.015 + Math.random() * 0.015,
          veinIdx: vi,
          // Bright saturated color (1.3x intensity)
          r: Math.min(255, Math.round(vein.r * 1.3)),
          g: Math.min(255, Math.round(vein.g * 1.3)),
          b: Math.min(255, Math.round(vein.b * 1.3)),
        });
        count++;
      }
    }

    // Update particle positions
    for (let pi = this.flowParticles.length - 1; pi >= 0; pi--) {
      const p = this.flowParticles[pi];
      p.progress += p.speed;

      if (p.progress >= 1) {
        const vein = this.veinPaths[p.veinIdx];
        if (vein && vein.active) {
          p.progress = 0; // respawn at start
          p.x = vein.x1;
          p.y = vein.y1;
        } else {
          this.flowParticles.splice(pi, 1);
          continue;
        }
      }

      const vein = this.veinPaths[p.veinIdx];
      if (!vein) {
        this.flowParticles.splice(pi, 1);
        continue;
      }

      p.x = vein.x1 + (vein.x2 - vein.x1) * p.progress;
      p.y = vein.y1 + (vein.y2 - vein.y1) * p.progress;

      // Deposit bright colored trail at particle position
      const ppx = Math.round(p.x), ppy = Math.round(p.y);
      if (ppx >= 0 && ppx < w && ppy >= 0 && ppy < h) {
        const idx = ppy * w + ppx;
        this.trailMap[idx] = Math.min(255, this.trailMap[idx] + 12);
        const cidx = idx * 3;
        this.colorMap[cidx]     = Math.round(this.colorMap[cidx]     * 0.5 + p.r * 0.5);
        this.colorMap[cidx + 1] = Math.round(this.colorMap[cidx + 1] * 0.5 + p.g * 0.5);
        this.colorMap[cidx + 2] = Math.round(this.colorMap[cidx + 2] * 0.5 + p.b * 0.5);

        // Small halo around particle for visibility
        const halo: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const [ox, oy] of halo) {
          const hx = ppx + ox, hy = ppy + oy;
          if (hx >= 0 && hx < w && hy >= 0 && hy < h) {
            const hi = hy * w + hx;
            this.trailMap[hi] = Math.min(255, this.trailMap[hi] + 5);
            const hci = hi * 3;
            this.colorMap[hci]     = Math.round(this.colorMap[hci]     * 0.7 + p.r * 0.3);
            this.colorMap[hci + 1] = Math.round(this.colorMap[hci + 1] * 0.7 + p.g * 0.3);
            this.colorMap[hci + 2] = Math.round(this.colorMap[hci + 2] * 0.7 + p.b * 0.3);
          }
        }
      }
    }
  }

  // ─── Diffuse + Decay (adaptive network — reinforcement near food) ─────

  private diffuseAndDecay() {
    const { decayRate, diffuseRate } = this.config;
    const w = this.width, h = this.height;
    const src = this.trailMap;
    const tmp = this.tmpTrailMap;
    tmp.fill(0);
    const hasFoods = this.foodSources.length > 0;

    for (let y = 1; y < h - 1; y++) {
      // Per-row: find nearest food source (only dy contributes — refine per pixel)
      // This avoids O(pixels * foods) by doing coarse row-level scan + column refinement
      let rowNearestFoodX = 0;
      let rowNearestFoodY = 0;
      let rowBestDySq = Infinity;
      if (hasFoods) {
        for (const f of this.foodSources) {
          const dySq = (y - f.y) * (y - f.y);
          if (dySq < rowBestDySq) {
            rowBestDySq = dySq;
            rowNearestFoodX = f.x;
            rowNearestFoodY = f.y;
          }
        }
      }

      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        // 3x3 box blur
        const avg = (
          src[idx - w - 1] + src[idx - w] + src[idx - w + 1] +
          src[idx - 1]     + src[idx]     + src[idx + 1] +
          src[idx + w - 1] + src[idx + w] + src[idx + w + 1]
        ) / 9;

        // Adaptive decay based on proximity to nearest food
        let adaptiveDecay = decayRate;
        if (hasFoods) {
          const dxf = x - rowNearestFoodX;
          const dyf = y - rowNearestFoodY;
          const distSq = dxf * dxf + dyf * dyf;
          if (distSq < NEAR_FOOD_SQ) {
            // Near food: reinforce — decay slower (max 1.0)
            adaptiveDecay = Math.min(1, decayRate * 1.05);
          } else if (distSq > FAR_FOOD_SQ) {
            // Far from food: decay faster
            adaptiveDecay = decayRate * 0.9;
          }
        }

        tmp[idx] = (src[idx] * (1 - diffuseRate) + avg * diffuseRate) * adaptiveDecay;
      }
    }

    [this.trailMap, this.tmpTrailMap] = [this.tmpTrailMap, this.trailMap];
  }

  // ─── Render ───────────────────────────────────────────────────────────

  /** Render trail map to an ImageData for display */
  renderToImageData(imageData: ImageData, bgR: number, bgG: number, bgB: number) {
    const pixels = imageData.data;
    const trail = this.trailMap;
    const color = this.colorMap;

    for (let i = 0; i < trail.length; i++) {
      const intensity = Math.min(trail[i] / 40, 1); // Normalize
      const pi = i * 4;
      const ci = i * 3;

      if (intensity < 0.01) {
        pixels[pi] = bgR;
        pixels[pi + 1] = bgG;
        pixels[pi + 2] = bgB;
        pixels[pi + 3] = 255;
      } else {
        // Default yellow if no food color assigned
        const cr = color[ci] || 255;
        const cg = color[ci + 1] || 210;
        const cb = color[ci + 2] || 20;
        // Blend trail color with background
        pixels[pi] = Math.round(bgR * (1 - intensity) + cr * intensity);
        pixels[pi + 1] = Math.round(bgG * (1 - intensity) + cg * intensity);
        pixels[pi + 2] = Math.round(bgB * (1 - intensity) + cb * intensity);
        pixels[pi + 3] = 255;
      }
    }
  }
}
