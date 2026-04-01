import fs from 'fs';

const files = fs.readdirSync('.').filter(f => f.endsWith('.html'));
files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');

  // Replace CDN Script
  content = content.replace(/<script src="https:\/\/cdn\.tailwindcss\.com[^>]*><\/script>\s*/g, '');
  
  // Replace Config script
  content = content.replace(/<script id="tailwind-config">[\s\S]*?<\/script>\s*/g, '');
  
  // Insert CSS link if missing
  if (!content.includes('<link rel="stylesheet" href="style.css"')) {
    content = content.replace(/(<\/head>)/i, '  <link rel="stylesheet" href="style.css" />\n$1');
  }

  fs.writeFileSync(file, content);
  console.log(`Updated ${file}`);
});
