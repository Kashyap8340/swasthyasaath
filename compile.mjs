import fs from 'fs';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import forms from '@tailwindcss/forms';
import containerQueries from '@tailwindcss/container-queries';

const css = `@tailwind base;
@tailwind components;
@tailwind utilities;`;

const files = fs.readdirSync('.').filter(f => f.endsWith('.html'));
const htmlContent = files.map(file => ({
  raw: fs.readFileSync(file, 'utf8'),
  extension: 'html'
}));

const config = {
  content: htmlContent,
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
    }
  },
  plugins: [forms, containerQueries]
};

postcss([tailwindcss(config)])
.process(css, { from: 'input.css', to: 'style.css' })
.then(result => {
  fs.writeFileSync('style.css', result.css);
  console.log('Compiled explicitly! Has bg-primary:', result.css.includes('bg-primary'));
})
.catch(err => console.error(err));
