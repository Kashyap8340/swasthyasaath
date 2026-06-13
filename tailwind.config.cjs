module.exports = {
  content: [
    "*.html",
    { raw: '<div class="bg-primary text-secondary text-primary hover:text-primary"></div>', extension: 'html' }
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "background-light": "#F9F8F4",
        "background-dark": "#2D3A31",
        "foreground": "#2D3A31",
        "primary": "#8C9A84",
        "secondary": "#DCCFC2",
        "border-color": "#E6E2DA",
        "terracotta": "#C27B66",
        "soft-clay": "#F2F0EB",
      },
      fontFamily: {
        "sans": ["Source Sans 3", "sans-serif"],
        "serif": ["Playfair Display", "serif"],
      },
      borderRadius: { "DEFAULT": "0.25rem", "lg": "0.5rem", "xl": "0.75rem", "2xl": "1rem", "3xl": "1.5rem", "full": "9999px" },
      boxShadow: {
        'soft': '0 4px 6px -1px rgba(45, 58, 49, 0.05)',
        'soft-md': '0 10px 15px -3px rgba(45, 58, 49, 0.05)',
        'soft-lg': '0 20px 40px -10px rgba(45, 58, 49, 0.05)',
        'soft-xl': '0 25px 50px -12px rgba(45, 58, 49, 0.15)',
      }
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('@tailwindcss/container-queries'),
    require('@tailwindcss/typography')
  ],
}
