// One-off icon generator: rebrand Happy "H" icons -> OMP glyph (omp.sh favicon.svg).
// Run from packages/happy-app: `node sources/trash/gen-omp-icons.mjs`
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// OMP brand glyph path (viewBox 0 0 64 64), bbox x[14..50] y[16..48], center (32,32).
const GLYPH = 'M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z';
const GRAD = `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#ed4abf"/>
  <stop offset=".5" stop-color="#9b4dff"/>
  <stop offset="1" stop-color="#5ad8e6"/>
</linearGradient>`;

// Full-bleed app icon: dark rounded square + gradient glyph (the omp.sh favicon, scaled).
const fullSVG = (s) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 64 64">
  <defs>${GRAD}</defs>
  <rect width="64" height="64" rx="12" fill="#0f0a14"/>
  <path fill="url(#g)" d="${GLYPH}"/>
</svg>`;

// Glyph centered on a transparent canvas inside the adaptive safe zone (~47% of frame).
// fill = "grad" (gradient) or a solid color string (e.g. "#ffffff").
const glyphSVG = (s, fill) => {
  const paint = fill === 'grad' ? 'url(#g)' : fill;
  const defs = fill === 'grad' ? `<defs>${GRAD}</defs>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 100 100">
  ${defs}
  <g transform="translate(50,50) scale(1.35) translate(-32,-32)">
    <path fill="${paint}" d="${GLYPH}"/>
  </g>
</svg>`;
};

const out = (rel) => resolve(process.cwd(), rel);
const render = async (svg, w, h) =>
  sharp(Buffer.from(svg)).resize(w, h, { fit: 'fill' }).png().toBuffer();

// rel path -> svg factory. Size is read from the existing file so we preserve dimensions.
const A = 'sources/assets/images';
const jobs = [
  // full-bleed (dark square + gradient glyph)
  [`${A}/icon.png`, 'full'],
  [`${A}/favicon.png`, 'full'],
  [`${A}/favicon-active.png`, 'full'],
  // android adaptive foreground (gradient glyph, transparent bg; bg #18171C applied by OS)
  [`${A}/icon-adaptive.png`, 'grad'],
  // android themed / monochrome (white silhouette, transparent)
  [`${A}/icon-monochrome.png`, '#ffffff'],
  // notification (alpha-only; white silhouette)
  [`${A}/icon-notification.png`, '#ffffff'],
  // splash logos (gradient glyph on transparent; bg color from app.config)
  [`${A}/splash-android-light.png`, 'grad'],
  [`${A}/splash-android-dark.png`, 'grad'],
  // brand logo.png copies
  ['logo.png', 'full'],
  ['../../logo.png', 'full'],
];

const main = async () => {
  for (const [rel, kind] of jobs) {
    const p = out(rel);
    const meta = await sharp(p).metadata();
    const w = meta.width, h = meta.height;
    const svg = kind === 'full' ? fullSVG(Math.max(w, h)) : glyphSVG(Math.max(w, h), kind);
    writeFileSync(p, await render(svg, w, h));
    console.log(`ok  ${rel}  ${w}x${h}  (${kind})`);
  }
};
main().catch((e) => { console.error(e); process.exit(1); });
