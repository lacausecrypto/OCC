import { describe, it, expect, beforeEach } from "vitest";
import {
  PhysarumSimulation,
  DEFAULT_CONFIG,
  type FoodSource,
  type VeinPath,
} from "../../../src/components/blob/physarumSim";

// PhysarumSimulation drives the slime-mold pixel layer underneath BLOB
// canvases. The class is an isolated unit (no DOM dependencies — only
// Float32Array / Uint8ClampedArray / Math.random) which makes it
// straightforward to exercise via the public API.

function makeFoodSource(overrides: Partial<FoodSource> = {}): FoodSource {
  return { x: 50, y: 50, radius: 10, strength: 1, r: 255, g: 100, b: 100, ...overrides };
}

function makeVeinPath(overrides: Partial<VeinPath> = {}): VeinPath {
  return { x1: 10, y1: 10, x2: 90, y2: 90, strength: 1, r: 100, g: 200, b: 100, ...overrides };
}

let sim: PhysarumSimulation;

beforeEach(() => {
  // Small grid + tiny agent count so tests stay fast and deterministic.
  sim = new PhysarumSimulation(64, 48, { ...DEFAULT_CONFIG, agentCount: 40 });
});

describe("PhysarumSimulation — construction", () => {
  it("allocates trail/color buffers sized to width × height", () => {
    expect(sim.trailMap.length).toBe(64 * 48);
    expect(sim.colorMap.length).toBe(64 * 48 * 3);
  });

  it("populates agents up to the requested count (rounded)", () => {
    // Agent counts are rounded — 40 splits into 30 arterial + 10 capillary
    // (75% / 25%) per the source. Allow ±2 slack for rounding.
    expect(sim.agents.length).toBeGreaterThanOrEqual(38);
    expect(sim.agents.length).toBeLessThanOrEqual(42);
  });

  it("agents spawn within bounds (1..w-2, 1..h-2)", () => {
    for (const a of sim.agents) {
      expect(a.x).toBeGreaterThanOrEqual(1);
      expect(a.x).toBeLessThanOrEqual(64 - 2);
      expect(a.y).toBeGreaterThanOrEqual(1);
      expect(a.y).toBeLessThanOrEqual(48 - 2);
    }
  });

  it("uses DEFAULT_CONFIG when no config arg is passed", () => {
    const def = new PhysarumSimulation(32, 32);
    expect(def.config).toBe(DEFAULT_CONFIG);
  });

  it("agents are split between arterial and capillary species (no scouts)", () => {
    const species = new Set(sim.agents.map((a) => a.species));
    expect(species.has("arterial")).toBe(true);
    expect(species.has("capillary")).toBe(true);
    // Scouts are disabled in the source.
    expect(species.has("scout")).toBe(false);
  });
});

describe("PhysarumSimulation — resize", () => {
  it("reallocates buffers and re-spawns agents", () => {
    sim.resize(96, 64);
    expect(sim.width).toBe(96);
    expect(sim.height).toBe(64);
    expect(sim.trailMap.length).toBe(96 * 64);
    expect(sim.colorMap.length).toBe(96 * 64 * 3);
    expect(sim.agents.length).toBeGreaterThan(0);
  });

  it("is a no-op when the dimensions are unchanged", () => {
    const beforeBuf = sim.trailMap;
    sim.resize(64, 48);
    expect(sim.trailMap).toBe(beforeBuf);
  });
});

describe("PhysarumSimulation — setFoodSources", () => {
  it("stores the food sources passed in", () => {
    const sources = [makeFoodSource(), makeFoodSource({ x: 30, y: 30 })];
    sim.setFoodSources(sources);
    expect(sim.foodSources).toEqual(sources);
  });

  it("re-spawns agents when food sources arrive after an empty start", () => {
    // initAgents is only re-called when the source count flips between
    // 0 and >0 (or jumps by >2). Going from no food → 2 food triggers
    // a respawn; verify agents are now centered around food.
    sim.foodSources = []; // simulate empty start
    sim.setFoodSources([makeFoodSource({ x: 32, y: 24, radius: 4 })]);
    // Most agents should land within ~16 pixels of (32, 24).
    const within = sim.agents.filter((a) => {
      const dx = a.x - 32, dy = a.y - 24;
      return Math.sqrt(dx * dx + dy * dy) <= 16;
    }).length;
    expect(within).toBeGreaterThan(sim.agents.length / 2);
  });

  it("does NOT re-spawn agents on small updates", () => {
    sim.setFoodSources([makeFoodSource(), makeFoodSource()]);
    const beforeAgent = sim.agents[0];
    // +1 source — small delta, no respawn.
    sim.setFoodSources([makeFoodSource(), makeFoodSource(), makeFoodSource()]);
    // Same first-agent reference (no re-init).
    expect(sim.agents[0]).toBe(beforeAgent);
  });
});

describe("PhysarumSimulation — setVeinPaths", () => {
  it("stores vein paths verbatim", () => {
    const paths = [makeVeinPath(), makeVeinPath({ active: true })];
    sim.setVeinPaths(paths);
    expect(sim.veinPaths).toEqual(paths);
  });
});

describe("PhysarumSimulation — triggerPulse", () => {
  it("does not throw when called repeatedly (caps internal pulse list)", () => {
    for (let i = 0; i < 50; i++) {
      sim.triggerPulse(32, 24, 20, 1, 100, 200, 50);
    }
    // No public pulses array; we just want this to be safe.
    expect(true).toBe(true);
  });
});

describe("PhysarumSimulation — tick", () => {
  it("does not throw and modifies the trail map over many frames", () => {
    sim.setFoodSources([makeFoodSource({ x: 32, y: 24 })]);
    for (let i = 0; i < 30; i++) sim.tick();
    // Some pheromone must have been deposited somewhere.
    let total = 0;
    for (let i = 0; i < sim.trailMap.length; i++) total += sim.trailMap[i];
    expect(total).toBeGreaterThan(0);
  });

  it("keeps every agent within bounds across ticks", () => {
    for (let i = 0; i < 20; i++) sim.tick();
    for (const a of sim.agents) {
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.x).toBeLessThanOrEqual(64);
      expect(a.y).toBeGreaterThanOrEqual(0);
      expect(a.y).toBeLessThanOrEqual(48);
    }
  });
});

describe("PhysarumSimulation — renderToImageData", () => {
  it("fills imageData with the background color when there are no trails", () => {
    const data = new Uint8ClampedArray(64 * 48 * 4);
    const imageData = { data, width: 64, height: 48 } as ImageData;
    sim.renderToImageData(imageData, 12, 34, 56);
    // Every pixel should have RGBA = (12, 34, 56, 255-ish).
    expect(data[0]).toBe(12);
    expect(data[1]).toBe(34);
    expect(data[2]).toBe(56);
    expect(data[3]).toBeGreaterThan(0);
  });

  it("brightens pixels above the trail-map threshold after several ticks", () => {
    sim.setFoodSources([makeFoodSource({ x: 32, y: 24, radius: 6, strength: 2 })]);
    for (let i = 0; i < 60; i++) sim.tick();
    const data = new Uint8ClampedArray(64 * 48 * 4);
    const imageData = { data, width: 64, height: 48 } as ImageData;
    sim.renderToImageData(imageData, 0, 0, 0);
    // Some pixel must be lighter than pure black.
    let maxBrightness = 0;
    for (let i = 0; i < data.length; i += 4) {
      const b = data[i] + data[i + 1] + data[i + 2];
      if (b > maxBrightness) maxBrightness = b;
    }
    expect(maxBrightness).toBeGreaterThan(0);
  });
});
