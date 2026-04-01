module.exports = {
  content: [
    "*.html",
    { raw: '<div class="bg-primary text-secondary text-primary hover:text-primary"></div>', extension: 'html' }
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "primary": "#0ea5e9",
        "secondary": "#10b981",
        "background-light": "#f8fafc",
        "background-dark": "#0f172a",
      },
      fontFamily: {
        "display": ["Public Sans", "sans-serif"]
      },
      borderRadius: { "DEFAULT": "0.25rem", "lg": "0.5rem", "xl": "0.75rem", "full": "9999px" },
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('@tailwindcss/container-queries'),
    require('@tailwindcss/typography')
  ],
}
