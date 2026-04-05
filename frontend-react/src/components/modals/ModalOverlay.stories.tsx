import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { ModalOverlay } from "./ModalOverlay";

const meta = {
  title: "Modals/ModalOverlay",
  component: ModalOverlay,
  args: { onClose: fn() },
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof ModalOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithContent: Story = {
  args: {
    children: (
      <div
        style={{
          background: "var(--m-bg, #1a1a1a)",
          color: "var(--m-fg, #fff)",
          padding: "32px 48px",
          borderRadius: "16px",
          maxWidth: 480,
        }}
      >
        <h2 style={{ margin: "0 0 12px" }}>Modal Title</h2>
        <p style={{ margin: 0, opacity: 0.7 }}>
          Click the overlay or press Escape to close.
        </p>
      </div>
    ),
  },
};
