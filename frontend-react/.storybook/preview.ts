import type { Preview } from '@storybook/react-vite'
import '../src/tokens.css'

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
       color: /(background|color)$/i,
       date: /Date$/i,
      },
    },
    a11y: {
      test: 'todo'
    },
    backgrounds: {
      default: 'dark',
      values: [
        { name: 'dark', value: '#0d0d0d' },
        { name: 'light', value: '#f5f5f5' },
      ],
    },
  },
};

export default preview;
