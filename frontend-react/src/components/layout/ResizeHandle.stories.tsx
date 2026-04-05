import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ResizeHandle } from "./ResizeHandle";

const meta = {
  title: "Layout/ResizeHandle",
  component: ResizeHandle,
  args: { onResize: fn() },
  argTypes: {
    side: { control: "radio", options: ["left", "right"] },
    hidden: { control: "boolean" },
  },
  decorators: [
    (Story) => (
      <div style={{ display: "flex", height: 200, alignItems: "stretch" }}>
        <div style={{ flex: 1, background: "var(--m-bg, #1a1a1a)" }} />
        <Story />
        <div style={{ flex: 1, background: "var(--m-bg2, #222)" }} />
      </div>
    ),
  ],
} satisfies Meta<typeof ResizeHandle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Left: Story = {
  args: { side: "left", hidden: false },
};

export const Right: Story = {
  args: { side: "right", hidden: false },
};

export const Hidden: Story = {
  args: { side: "left", hidden: true },
};
