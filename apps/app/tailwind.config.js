/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    "./app/**/*.{js,jsx,ts,tsx}",
    "./components/**/*.{js,jsx,ts,tsx}",
    "./lib/**/*.{js,jsx,ts,tsx}",
    "./hooks/**/*.{js,jsx,ts,tsx}",
  ],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      },
      colors: ({ colorScheme }) => ({
        border: colorScheme === 'dark' ? "hsl(0 0% 100% / 10%)" : "hsl(0 0% 90%)",
        input: colorScheme === 'dark' ? "hsl(0 0% 100% / 15%)" : "hsl(0 0% 90%)",
        ring: "hsl(288 77% 62%)",
        background: colorScheme === 'dark' ? "hsl(230 62% 4%)" : "hsl(0 0% 100%)",
        foreground: colorScheme === 'dark' ? "hsl(0 0% 100%)" : "hsl(0 0% 0%)",
        primary: {
          DEFAULT: "hsl(288 77% 62%)",
          foreground: "hsl(0 0% 100%)",
        },
        secondary: {
          DEFAULT: colorScheme === 'dark' ? "hsl(217 26% 17%)" : "hsl(0 0% 96%)",
          foreground: colorScheme === 'dark' ? "hsl(0 0% 100%)" : "hsl(0 0% 0%)",
        },
        destructive: {
          DEFAULT: "hsl(0 84% 60%)",
          foreground: "hsl(0 0% 100%)",
        },
        muted: {
          DEFAULT: colorScheme === 'dark' ? "hsl(217 26% 17%)" : "hsl(0 0% 96%)",
          foreground: colorScheme === 'dark' ? "hsl(0 0% 70%)" : "hsl(0 0% 45%)",
        },
        accent: {
          DEFAULT: colorScheme === 'dark' ? "hsl(217 26% 17%)" : "hsl(0 0% 96%)",
          foreground: colorScheme === 'dark' ? "hsl(0 0% 100%)" : "hsl(0 0% 0%)",
        },
        popover: {
          DEFAULT: colorScheme === 'dark' ? "hsl(217 26% 17%)" : "hsl(0 0% 100%)",
          foreground: colorScheme === 'dark' ? "hsl(0 0% 100%)" : "hsl(0 0% 0%)",
        },
        surface: {
          DEFAULT: colorScheme === 'dark' ? "hsl(217 26% 17%)" : "hsl(0 0% 98%)",
          foreground: colorScheme === 'dark' ? "hsl(0 0% 100%)" : "hsl(0 0% 0%)",
        },
        chart: {
          1: "hsl(288 77% 85%)",
          2: "hsl(288 77% 75%)",
          3: "hsl(288 77% 65%)",
          4: "hsl(288 77% 55%)",
          5: "hsl(288 77% 45%)",
        },
        sidebar: {
          DEFAULT: colorScheme === 'dark' ? "hsl(217 26% 17%)" : "hsl(0 0% 98%)",
          foreground: colorScheme === 'dark' ? "hsl(0 0% 100%)" : "hsl(0 0% 0%)",
          primary: "hsl(288 77% 62%)",
          "primary-foreground": "hsl(0 0% 100%)",
          accent: colorScheme === 'dark' ? "hsl(217 26% 17%)" : "hsl(0 0% 96%)",
          "accent-foreground": colorScheme === 'dark' ? "hsl(0 0% 100%)" : "hsl(0 0% 0%)",
          border: colorScheme === 'dark' ? "hsl(0 0% 100% / 10%)" : "hsl(0 0% 90%)",
          ring: "hsl(288 77% 62%)",
        },
      }),
    },
  },
  plugins: [],
}
