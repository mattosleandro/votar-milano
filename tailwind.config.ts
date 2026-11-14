import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './hooks/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      gridTemplateColumns: {
        '16': 'repeat(16, minmax(0, 1fr))',
        '17': 'repeat(17, minmax(0, 1fr))',
      },
      colors: {
        milano: {
          gold: '#CCB285',
          'gold-light': '#DFCCA9',
          'gold-dark': '#A88E61',
          obsidian: '#0C0C0D',
          surface: '#141518',
        },
      },
      fontFamily: {
        sans: ['var(--font-jakarta)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-jetbrains)', 'ui-monospace', 'monospace'],
      },
      keyframes: {
        'pulse-subtle': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.68' },
        },
      },
      animation: {
        'pulse-subtle': 'pulse-subtle 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
};

export default config;
