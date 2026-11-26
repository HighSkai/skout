// Renders the PNG images used by the extension and the README:
//
//   images/icon.png         Marketplace / extension icon, from images/logo.svg
//   images/banner.png          README header
//   images/social-preview.png  GitHub social preview (Settings > Social preview)
//   images/diagnostics.png  Skout's real diagnostics on test-workspace/scripts/broken.sk
//
// diagnostics.png is drawn from the parser's actual output, not mocked up, so
// re-run `npm run images` whenever messages change.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, '..');
const images = join(root, 'images');

function png(svg, width) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { loadSystemFonts: true, defaultFontFamily: 'Segoe UI' },
  });
  return resvg.render().asPng();
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const logo = readFileSync(join(images, 'logo.svg'), 'utf8');
const logoInner = logo.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title>.*?<\/title>/, '');

// --- icon -------------------------------------------------------------------
writeFileSync(join(images, 'icon.png'), png(logo, 256));

// --- banner (README) and social preview (GitHub, 1280 x 640) ----------------
function card(W, H, footer = '') {
  const mid = H / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#14231b"/>
      <stop offset="1" stop-color="#08130d"/>
    </linearGradient>
    <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
      <path d="M32 0H0V32" fill="none" stroke="#ffffff" stroke-opacity="0.035" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#grid)"/>
  <g transform="translate(110 ${mid - 120}) scale(1.875)">${logoInner}</g>
  <text x="400" y="${mid - 10}" font-family="Segoe UI" font-weight="700" font-size="104" fill="#f0fdf4">Skout</text>
  <text x="404" y="${mid + 48}" font-family="Segoe UI" font-size="31" fill="#a7f3d0">Scouts your Skript for problems before /sk reload.</text>
  <text x="404" y="${mid + 106}" font-family="Segoe UI" font-size="22" fill="#6b8f7b">Language server and VS Code extension for Minecraft Skript</text>
  ${footer ? `<text x="${W - 48}" y="${H - 40}" font-family="Segoe UI" font-size="22" fill="#4d6b5a" text-anchor="end">${esc(footer)}</text>` : ''}
</svg>`;
}
writeFileSync(join(images, 'banner.png'), png(card(1280, 400), 1280));
writeFileSync(join(images, 'social-preview.png'), png(card(1280, 640, 'github.com/HighSkai/skout'), 1280));

// --- diagnostics ------------------------------------------------------------
{
  const outfile = join(root, 'node_modules', '.cache', 'skout-render', 'parser.cjs');
  mkdirSync(join(outfile, '..'), { recursive: true });
  esbuild.buildSync({ entryPoints: [join(root, 'server/src/parser/parser.ts')], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' });
  const { parseScript } = require(outfile);

  const file = 'test-workspace/scripts/broken.sk';
  const text = readFileSync(join(root, file), 'utf8').replace(/\n$/, '');
  const script = parseScript(text);
  const sourceLines = text.split('\n');

  const W = 1280;
  const charW = 8.8; // Consolas at 16px
  const lineH = 25;
  const codeX = 70;
  const top = 56;
  const panelTop = top + sourceLines.length * lineH + 26;
  const rowH = 30;
  const H = panelTop + 44 + script.issues.length * rowH + 48;
  const COLOR = { error: '#f14c4c', warning: '#cca700', information: '#3794ff', hint: '#3794ff' };

  const col = (line, c) => line.slice(0, c).replace(/\t/g, '    ').length;
  const tokens = (line) => {
    // Small highlighter for the picture only; the extension uses the TextMate grammar.
    const out = [];
    const re = /("(?:[^"]|"")*"?)|(\{@[^}]*\})|(\{[^}]*\}?)|(#.*$)|(^\s*(?:on|command|function|options|if|else|loop|trigger|send|set|every)\b)|(\b\d+%?)|([^"{#\d]+|.)/g;
    let m;
    while ((m = re.exec(line))) {
      const [t] = m;
      const color = m[1] ? '#ce9178' : m[2] ? '#4fc1ff' : m[3] ? '#9cdcfe' : m[4] ? '#6a9955' : m[5] ? '#c586c0' : m[6] ? '#b5cea8' : '#d4d4d4';
      out.push({ t, color });
    }
    return out;
  };
  const wave = (x1, x2, y, color) => {
    let d = `M${x1} ${y}`;
    for (let x = x1; x < x2; x += 4) d += ` q1 ${(x - x1) % 8 === 0 ? -3 : 3} 2 0 t2 0`;
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.4"/>`;
  };

  let body = '';
  sourceLines.forEach((line, i) => {
    const y = top + i * lineH;
    body += `<text x="${codeX - 22}" y="${y + 17}" font-family="Consolas" font-size="15" fill="#5a6b62" text-anchor="end">${i + 1}</text>`;
    let x = codeX;
    let spans = '';
    for (const { t, color } of tokens(line.replace(/\t/g, '    '))) {
      spans += `<tspan fill="${color}">${esc(t)}</tspan>`;
      x += t.length * charW;
    }
    body += `<text x="${codeX}" y="${y + 17}" font-family="Consolas" font-size="16" xml:space="preserve">${spans}</text>`;
  });
  for (const issue of script.issues) {
    const line = sourceLines[issue.line];
    const x1 = codeX + col(line, issue.start) * charW;
    const x2 = Math.max(x1 + 10, codeX + col(line, issue.end) * charW);
    body += wave(x1, x2, top + issue.line * lineH + 22, COLOR[issue.severity]);
  }

  body += `<rect x="0" y="${panelTop}" width="${W}" height="${H - panelTop}" fill="#181818"/>`;
  body += `<line x1="0" y1="${panelTop}" x2="${W}" y2="${panelTop}" stroke="#2b2b2b"/>`;
  body += `<text x="24" y="${panelTop + 29}" font-family="Segoe UI" font-weight="600" font-size="13" letter-spacing="1" fill="#cccccc">PROBLEMS</text>`;
  body += `<text x="112" y="${panelTop + 29}" font-family="Segoe UI" font-size="13" fill="#8b949e">${script.issues.length} in broken.sk</text>`;
  script.issues.forEach((issue, i) => {
    const y = panelTop + 44 + i * rowH;
    const where = `skout(${issue.code})  [Ln ${issue.line + 1}, Col ${issue.start + 1}]`;
    const max = 150;
    const message = issue.message.length > max ? issue.message.slice(0, max - 1) + '…' : issue.message;
    body += `<circle cx="34" cy="${y + 13}" r="6" fill="${COLOR[issue.severity]}"/>`;
    body += `<text x="50" y="${y + 18}" font-family="Segoe UI" font-size="14" fill="#e6e6e6">${esc(message)}<tspan fill="#8b949e" dx="10">${esc(where)}</tspan></text>`;
  });
  body += `<text x="${W - 24}" y="${H - 16}" font-family="Segoe UI" font-size="12.5" fill="#5a6b62" text-anchor="end">Rendered from Skout's real output on ${file}</text>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" rx="10" fill="#1f1f1f"/>
  <rect x="0" y="0" width="${W}" height="36" fill="#181818"/>
  <circle cx="22" cy="18" r="6" fill="#ff5f57"/><circle cx="42" cy="18" r="6" fill="#febc2e"/><circle cx="62" cy="18" r="6" fill="#28c840"/>
  <text x="${W / 2}" y="23" font-family="Segoe UI" font-size="13" fill="#9d9d9d" text-anchor="middle">broken.sk — test-workspace</text>
  ${body}
</svg>`;
  writeFileSync(join(images, 'diagnostics.png'), png(svg, W));
}

console.log('Rendered icon.png, banner.png, social-preview.png and diagnostics.png in images/');
