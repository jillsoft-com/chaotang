/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        imperial: {
          gold: '#d4af37',
          red: '#8b0000',
          dark: '#1a1a1a',
        }
      },
      fontFamily: {
        serif: ['Noto Serif SC', 'serif'],
      }
    },
  },
  plugins: [],
}
