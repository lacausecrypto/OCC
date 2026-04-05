import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { CollapseButton } from "./CollapseButton";

const meta = {
  title: "Layout/CollapseButton",
  component: CollapseButton,
  args: { onClick: fn() },
  argTypes: {
    side: { control: "radio", options: ["left", "right"] },
    collapsed: { control: "boolean" },
    title: { control: "text" },
  },
} satisfies Meta<typeof CollapseButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LeftExpanded: Story = {
  args: { side: "left", collapsed: false, title: "Collapse sidebar" },
};

export const LeftCollapsed: Story = {
  args: { side: "left", collapsed: true, title: "Expand sidebar" },
};

export const RightExpanded: Story = {
  args: { side: "right", collapsed: false, title: "Collapse design panel" },
};

export const RightCollapsed: Story = {
  args: { side: "right", collapsed: true, title: "Expand design panel" },
};
