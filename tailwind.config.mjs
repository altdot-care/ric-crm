/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        ric: {
          red: '#B5121B',
          'red-dark': '#6C100F',
          gray: '#8A8A8A',
          'gray-light': '#F5F5F5',
          black: '#111111',
          sidebar: '#1D1819',
          'sidebar-hover': '#2D2122',
        },
      },
      fontFamily: {
        sans: ['"DM Sans"', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'monospace'],
      },
    },
  },
  plugins: [],
};
