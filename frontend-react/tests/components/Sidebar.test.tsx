import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useDesignStore, DEFAULT_PRESETS, SLIDER_DEFS } from "../../src/stores/design";
import type { DesignPreset } from "../../src/types/design";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../../src/components/sidebar/Sidebar.module.css", () => ({
  default: {
    section: "section",
    sectionTitle: "sectionTitle",
    refGrid: "refGrid",
    refSlot: "refSlot",
    hasImg: "hasImg",
    refSlotDragover: "refSlotDragover",
    refThumb: "refThumb",
    refPlaceholder: "refPlaceholder",
    refInfo: "refInfo",
    refName: "refName",
    refUrlInput: "refUrlInput",
    refRemove: "refRemove",
    blendHint: "blendHint",
    blendArea: "blendArea",
    blendKnob: "blendKnob",
    controlsRow: "controlsRow",
    dayNightBtn: "dayNightBtn",
    dayNightIcon: "dayNightIcon",
    dayNightToggle: "dayNightToggle",
    dayNightDot: "dayNightDot",
    ctrlBtn: "ctrlBtn",
    ctrlBtnIcon: "ctrlBtnIcon",
    shuffleIcon: "shuffleIcon",
    themeManagerWrap: "themeManagerWrap",
    themeMenu: "themeMenu",
    themeMenuSave: "themeMenuSave",
    themeMenuEmpty: "themeMenuEmpty",
    themeMenuList: "themeMenuList",
    themeMenuItem: "themeMenuItem",
    themeMenuDots: "themeMenuDots",
    themeMenuName: "themeMenuName",
    themeMenuInput: "themeMenuInput",
    themeMenuLabel: "themeMenuLabel",
    themeMenuActions: "themeMenuActions",
    themesBadge: "themesBadge",
    sliderList: "sliderList",
    sliderRow: "sliderRow",
    sliderRowFont: "sliderRowFont",
    sliderLabel: "sliderLabel",
    sliderSwatch: "sliderSwatch",
    sliderVal: "sliderVal",
    sliderTrack: "sliderTrack",
    sliderFill: "sliderFill",
    sliderGroupLabel: "sliderGroupLabel",
    themePreview: "themePreview",
    themePreviewBar: "themePreviewBar",
    themePreviewAccent: "themePreviewAccent",
  },
}));

vi.mock("../../src/utils/extractPalette", () => ({
  extractPaletteFromImage: vi.fn().mockResolvedValue(null),
  extractSiteStyle: vi.fn().mockResolvedValue({
    name: "Extracted",
    fontFamily: "system-ui",
    bg: [0, 0, 10] as [number, number, number],
    surface: [0, 0, 15] as [number, number, number],
    accent: [200, 80, 50] as [number, number, number],
    text: [0, 0, 90] as [number, number, number],
    text2: [0, 0, 50] as [number, number, number],
    border: [0, 0, 20] as [number, number, number],
    headingSize: 22, headingWeight: 600, bodySize: 14, bodyWeight: 400,
    lineHeight: 1.5, gridCols: 3, gap: 16, padding: 18, radius: 12,
    borderWidth: 1, elevation: 30,
  }),
}));

vi.mock("../../src/utils/randomDesign", () => ({
  generateRandomPresetSet: vi.fn(() =>
    DEFAULT_PRESETS.map((p) => ({
      ...p,
      accent: [Math.random() * 360, 80, 50] as [number, number, number],
    })),
  ),
}));

// Stub canvas getContext for BlendMatrix
HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
  setTransform: vi.fn(),
  fillRect: vi.fn(),
  strokeStyle: "",
  lineWidth: 1,
  fillStyle: "",
  globalAlpha: 1,
  font: "",
  textAlign: "left",
  imageSmoothingEnabled: true,
  imageSmoothingQuality: "low",
  setLineDash: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  arc: vi.fn(),
  fillText: vi.fn(),
  drawImage: vi.fn(),
  createImageData: vi.fn(() => ({ data: new Uint8ClampedArray(50 * 50 * 4) })),
  putImageData: vi.fn(),
})) as unknown as typeof HTMLCanvasElement.prototype.getContext;

// Stub getComputedStyle for BlendMatrix draw
const origGetComputedStyle = globalThis.getComputedStyle;
vi.spyOn(globalThis, "getComputedStyle").mockImplementation((elt) => {
  const result = origGetComputedStyle(elt);
  return new Proxy(result, {
    get(target, prop) {
      if (prop === "getPropertyValue") {
        return (_name: string) => "";
      }
      return Reflect.get(target, prop);
    },
  });
});

// ─── Reset store before each test ─────────────────────────────────────────────

beforeEach(() => {
  useDesignStore.setState({
    presets: DEFAULT_PRESETS.map((p) => ({ ...p })),
    blendX: 0.5,
    blendY: 0.5,
  });
  localStorage.clear();
});

// ─── ReferenceSlot ────────────────────────────────────────────────────────────

describe("ReferenceSlot", () => {
  // Lazy import to ensure mocks are set up
  let ReferenceSlot: typeof import("../../src/components/sidebar/ReferenceSlot").ReferenceSlot;

  beforeEach(async () => {
    const mod = await import("../../src/components/sidebar/ReferenceSlot");
    ReferenceSlot = mod.ReferenceSlot;
  });

  it("renders slot placeholder when empty", () => {
    render(
      <ReferenceSlot
        index={0}
        name="Apple Dark"
        loadedUrl={null}
        imageUrl={null}
        onLoad={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(screen.getByText("Slot 1")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("paste URL + Enter")).toBeInTheDocument();
  });

  it("renders loaded URL display name", () => {
    render(
      <ReferenceSlot
        index={1}
        name="Neon Cyber"
        loadedUrl="https://www.example.com/"
        imageUrl="/proxy?url=example"
        onLoad={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(screen.getByText("example")).toBeInTheDocument();
  });

  it("shows + placeholder when not loading", () => {
    render(
      <ReferenceSlot
        index={0}
        name="Apple Dark"
        loadedUrl={null}
        imageUrl={null}
        loading={false}
        onLoad={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(screen.getByText("+")).toBeInTheDocument();
  });

  it("shows spinner placeholder when loading", () => {
    render(
      <ReferenceSlot
        index={0}
        name="Apple Dark"
        loadedUrl={null}
        imageUrl={null}
        loading={true}
        onLoad={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    // The spinner uses ↻ character (&#8635;)
    expect(screen.getByText("\u21BB")).toBeInTheDocument();
  });

  it("calls onClear when remove button is clicked", () => {
    const onClear = vi.fn();
    render(
      <ReferenceSlot
        index={2}
        name="Warm Earth"
        loadedUrl="https://example.com"
        imageUrl="/img"
        onLoad={vi.fn()}
        onClear={onClear}
      />,
    );
    // The remove button has &times; which is the multiplication sign
    const removeBtn = screen.getByText("\u00D7");
    fireEvent.click(removeBtn);
    expect(onClear).toHaveBeenCalledWith(2);
  });

  it("calls onLoad with https:// prefix when URL entered and Enter pressed", () => {
    const onLoad = vi.fn();
    render(
      <ReferenceSlot
        index={0}
        name="Apple Dark"
        loadedUrl={null}
        imageUrl={null}
        onLoad={onLoad}
        onClear={vi.fn()}
      />,
    );
    const input = screen.getByPlaceholderText("paste URL + Enter");
    fireEvent.change(input, { target: { value: "example.com" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onLoad).toHaveBeenCalledWith(0, "https://example.com");
  });

  it("does not call onLoad when Enter pressed with empty input", () => {
    const onLoad = vi.fn();
    render(
      <ReferenceSlot
        index={0}
        name="Apple Dark"
        loadedUrl={null}
        imageUrl={null}
        onLoad={onLoad}
        onClear={vi.fn()}
      />,
    );
    const input = screen.getByPlaceholderText("paste URL + Enter");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onLoad).not.toHaveBeenCalled();
  });

  it("preserves https:// prefix if already present", () => {
    const onLoad = vi.fn();
    render(
      <ReferenceSlot
        index={1}
        name="Neon Cyber"
        loadedUrl={null}
        imageUrl={null}
        onLoad={onLoad}
        onClear={vi.fn()}
      />,
    );
    const input = screen.getByPlaceholderText("paste URL + Enter");
    fireEvent.change(input, { target: { value: "https://github.com" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onLoad).toHaveBeenCalledWith(1, "https://github.com");
  });

  it("renders image when imageUrl provided", () => {
    const { container } = render(
      <ReferenceSlot
        index={0}
        name="Test"
        loadedUrl="https://example.com"
        imageUrl="/proxy?url=test"
        onLoad={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    const img = container.querySelector("img");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "/proxy?url=test");
  });
});

// ─── BlendMatrix ──────────────────────────────────────────────────────────────

describe("BlendMatrix", () => {
  let BlendMatrix: typeof import("../../src/components/sidebar/BlendMatrix").BlendMatrix;

  beforeEach(async () => {
    const mod = await import("../../src/components/sidebar/BlendMatrix");
    BlendMatrix = mod.BlendMatrix;
  });

  it("renders hint text when no references loaded", () => {
    render(<BlendMatrix slotUrls={[null, null, null, null]} />);
    expect(screen.getByText("Load a reference to start")).toBeInTheDocument();
  });

  it("shows '1 reference loaded' when 1 slot has non-default preset", () => {
    // Modify one preset to be non-default
    const presets = DEFAULT_PRESETS.map((p) => ({ ...p }));
    presets[0] = { ...presets[0], accent: [50, 90, 60] };
    useDesignStore.setState({ presets });

    render(<BlendMatrix slotUrls={["https://example.com", null, null, null]} />);
    expect(screen.getByText("1 reference loaded")).toBeInTheDocument();
  });

  it("renders blend area and canvas", () => {
    const { container } = render(<BlendMatrix slotUrls={[null, null, null, null]} />);
    expect(container.querySelector("canvas")).toBeInTheDocument();
  });

  it("shows knob when 2+ presets are loaded", () => {
    const presets = DEFAULT_PRESETS.map((p) => ({ ...p }));
    presets[0] = { ...presets[0], accent: [50, 90, 60] };
    presets[1] = { ...presets[1], accent: [100, 80, 55] };
    useDesignStore.setState({ presets });

    const { container } = render(
      <BlendMatrix slotUrls={["https://a.com", "https://b.com", null, null]} />,
    );
    expect(container.querySelector(".blendKnob")).toBeInTheDocument();
  });

  it("does not show knob when less than 2 loaded", () => {
    const { container } = render(<BlendMatrix slotUrls={[null, null, null, null]} />);
    expect(container.querySelector(".blendKnob")).not.toBeInTheDocument();
  });

  it("sets crosshair cursor when 2+ loaded", () => {
    const presets = DEFAULT_PRESETS.map((p) => ({ ...p }));
    presets[0] = { ...presets[0], accent: [50, 90, 60] };
    presets[1] = { ...presets[1], accent: [100, 80, 55] };
    useDesignStore.setState({ presets });

    const { container } = render(
      <BlendMatrix slotUrls={["https://a.com", "https://b.com", null, null]} />,
    );
    const blendArea = container.querySelector(".blendArea");
    expect(blendArea).toHaveStyle({ cursor: "crosshair" });
  });

  it("sets default cursor when less than 2 loaded", () => {
    const { container } = render(<BlendMatrix slotUrls={[null, null, null, null]} />);
    const blendArea = container.querySelector(".blendArea");
    expect(blendArea).toHaveStyle({ cursor: "default" });
  });
});

// ─── LiveSliders ──────────────────────────────────────────────────────────────

describe("LiveSliders", () => {
  let LiveSliders: typeof import("../../src/components/sidebar/LiveSliders").LiveSliders;

  beforeEach(async () => {
    const mod = await import("../../src/components/sidebar/LiveSliders");
    LiveSliders = mod.LiveSliders;
  });

  it("renders group labels", () => {
    render(<LiveSliders />);
    expect(screen.getByText("Colors")).toBeInTheDocument();
    expect(screen.getByText("Typography")).toBeInTheDocument();
    expect(screen.getByText("Layout")).toBeInTheDocument();
  });

  it("renders slider labels matching SLIDER_DEFS", () => {
    render(<LiveSliders />);
    // Check a few known labels
    expect(screen.getByText("bg")).toBeInTheDocument();
    expect(screen.getByText("accent")).toBeInTheDocument();
    expect(screen.getByText("font")).toBeInTheDocument();
    expect(screen.getByText("heading")).toBeInTheDocument();
    expect(screen.getByText("radius")).toBeInTheDocument();
  });

  it("renders theme preview bar with Aa text", () => {
    render(<LiveSliders />);
    expect(screen.getByText("Aa")).toBeInTheDocument();
  });

  it("renders Abc preview text", () => {
    render(<LiveSliders />);
    expect(screen.getByText("Abc")).toBeInTheDocument();
  });

  it("shows numeric values for numeric sliders", () => {
    render(<LiveSliders />);
    // The default heading size is blended from presets (mean of 20,26,24,18 ~ 22)
    // Just check some numeric value exists
    const sliderVals = document.querySelectorAll(".sliderVal");
    expect(sliderVals.length).toBeGreaterThan(0);
  });

  it("shows color values with degree notation", () => {
    const { container } = render(<LiveSliders />);
    // Color sliders show "H° S% L%" format
    expect(container.textContent).toMatch(/\d+°\s*\d+%\s*\d+%/);
  });
});

// ─── ThemeManager ─────────────────────────────────────────────────────────────

describe("ThemeManager", () => {
  let ThemeManager: typeof import("../../src/components/sidebar/ThemeManager").ThemeManager;

  beforeEach(async () => {
    const mod = await import("../../src/components/sidebar/ThemeManager");
    ThemeManager = mod.ThemeManager;
  });

  it("renders Themes button", () => {
    render(<ThemeManager />);
    expect(screen.getByText("Themes")).toBeInTheDocument();
  });

  it("does not show badge when no saved themes", () => {
    render(<ThemeManager />);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("opens menu on button click", () => {
    render(<ThemeManager />);
    fireEvent.click(screen.getByText("Themes"));
    expect(screen.getByText("+ Save current theme")).toBeInTheDocument();
    expect(screen.getByText("No saved themes")).toBeInTheDocument();
  });

  it("closes menu on second click", () => {
    render(<ThemeManager />);
    fireEvent.click(screen.getByText("Themes"));
    expect(screen.getByText("+ Save current theme")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Themes"));
    expect(screen.queryByText("+ Save current theme")).not.toBeInTheDocument();
  });

  it("saves a theme and shows it in the list", () => {
    render(<ThemeManager />);
    fireEvent.click(screen.getByText("Themes"));
    fireEvent.click(screen.getByText("+ Save current theme"));
    // After save, theme enters editing mode — value visible in input
    expect(screen.getByDisplayValue("Theme 1")).toBeInTheDocument();
    expect(screen.queryByText("No saved themes")).not.toBeInTheDocument();
  });

  it("shows badge with saved theme count", () => {
    render(<ThemeManager />);
    fireEvent.click(screen.getByText("Themes"));
    fireEvent.click(screen.getByText("+ Save current theme"));
    // Badge shows "1"
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("deletes a theme when delete button clicked", () => {
    render(<ThemeManager />);
    fireEvent.click(screen.getByText("Themes"));
    fireEvent.click(screen.getByText("+ Save current theme"));
    // Confirm theme is saved (in editing mode)
    expect(screen.getByDisplayValue("Theme 1")).toBeInTheDocument();

    // Click delete button (✕)
    fireEvent.click(screen.getByTitle("Delete"));
    expect(screen.queryByDisplayValue("Theme 1")).not.toBeInTheDocument();
    expect(screen.getByText("No saved themes")).toBeInTheDocument();
  });

  it("enters rename mode when rename button clicked", () => {
    render(<ThemeManager />);
    fireEvent.click(screen.getByText("Themes"));
    fireEvent.click(screen.getByText("+ Save current theme"));

    fireEvent.click(screen.getByTitle("Rename"));
    const input = screen.getByDisplayValue("Theme 1") as HTMLInputElement;
    expect(input).toBeInTheDocument();
  });

  it("renames a theme on Enter", () => {
    render(<ThemeManager />);
    fireEvent.click(screen.getByText("Themes"));
    fireEvent.click(screen.getByText("+ Save current theme"));

    fireEvent.click(screen.getByTitle("Rename"));
    const input = screen.getByDisplayValue("Theme 1") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "My Theme" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("My Theme")).toBeInTheDocument();
  });

  it("renames to 'Untitled' if blank name submitted", () => {
    render(<ThemeManager />);
    fireEvent.click(screen.getByText("Themes"));
    fireEvent.click(screen.getByText("+ Save current theme"));

    fireEvent.click(screen.getByTitle("Rename"));
    const input = screen.getByDisplayValue("Theme 1") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("Untitled")).toBeInTheDocument();
  });

  it("cancels rename on Escape", () => {
    render(<ThemeManager />);
    fireEvent.click(screen.getByText("Themes"));
    fireEvent.click(screen.getByText("+ Save current theme"));

    fireEvent.click(screen.getByTitle("Rename"));
    const input = screen.getByDisplayValue("Theme 1") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Changed" } });
    fireEvent.keyDown(input, { key: "Escape" });
    // Should exit editing mode (label visible, not input)
    expect(screen.getByText("Theme 1")).toBeInTheDocument();
  });

  it("loads a theme into the design store", () => {
    render(<ThemeManager />);
    fireEvent.click(screen.getByText("Themes"));
    fireEvent.click(screen.getByText("+ Save current theme"));

    // Finish editing by pressing Enter so the label becomes clickable
    const input = screen.getByDisplayValue("Theme 1");
    fireEvent.keyDown(input, { key: "Enter" });

    // Modify store to something different
    const modified = DEFAULT_PRESETS.map((p) => ({ ...p, accent: [0, 100, 50] as [number, number, number] }));
    useDesignStore.setState({ presets: modified });

    // Click theme label to load
    fireEvent.click(screen.getByText("Theme 1"));

    // Store should be restored to original default presets
    const state = useDesignStore.getState();
    expect(state.presets[0].accent[0]).toBe(DEFAULT_PRESETS[0].accent[0]);
  });

  it("persists themes to localStorage", () => {
    render(<ThemeManager />);
    fireEvent.click(screen.getByText("Themes"));
    fireEvent.click(screen.getByText("+ Save current theme"));

    expect(localStorage.setItem).toHaveBeenCalledWith(
      "occ-saved-themes",
      expect.any(String),
    );
  });
});

// ─── DesignSidebar ────────────────────────────────────────────────────────────

describe("DesignSidebar", () => {
  let DesignSidebar: typeof import("../../src/components/sidebar/DesignSidebar").DesignSidebar;

  beforeEach(async () => {
    const mod = await import("../../src/components/sidebar/DesignSidebar");
    DesignSidebar = mod.DesignSidebar;
  });

  it("renders section titles", () => {
    render(<DesignSidebar />);
    expect(screen.getByText("Reference Styles")).toBeInTheDocument();
    expect(screen.getByText("Live Parameters")).toBeInTheDocument();
  });

  it("renders 4 reference slots", () => {
    render(<DesignSidebar />);
    expect(screen.getByText("Slot 1")).toBeInTheDocument();
    expect(screen.getByText("Slot 2")).toBeInTheDocument();
    expect(screen.getByText("Slot 3")).toBeInTheDocument();
    expect(screen.getByText("Slot 4")).toBeInTheDocument();
  });

  it("renders day/night toggle button", () => {
    render(<DesignSidebar />);
    // Default is dark mode
    expect(screen.getByText("Dark")).toBeInTheDocument();
  });

  it("toggles day/night mode on click", () => {
    render(<DesignSidebar />);
    const btn = screen.getByTitle("Switch to Light mode");
    fireEvent.click(btn);
    expect(screen.getByText("Light")).toBeInTheDocument();

    const btn2 = screen.getByTitle("Switch to Dark mode");
    fireEvent.click(btn2);
    expect(screen.getByText("Dark")).toBeInTheDocument();
  });

  it("shows Shuffle button when no references loaded", () => {
    render(<DesignSidebar />);
    expect(screen.getByText("Shuffle")).toBeInTheDocument();
  });

  it("renders Themes button", () => {
    render(<DesignSidebar />);
    expect(screen.getByText("Themes")).toBeInTheDocument();
  });

  it("renders blend matrix hint", () => {
    render(<DesignSidebar />);
    expect(screen.getByText("Load a reference to start")).toBeInTheDocument();
  });
});
