import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const WIDTH = 1024;
const HEIGHT = 1024;

// CRC32 table for PNG chunk checksums
const crcTable = (() => {
  let c;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const crcVal = crc32(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crcVal, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(pixels: Uint8Array, width: number, height: number): Buffer {
  const rowBytes = width * 4;
  const filtered = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    filtered[y * (rowBytes + 1)] = 0; // Filter type 0 (None)
    pixels.subarray(y * rowBytes, (y + 1) * rowBytes).forEach((val, i) => {
      filtered[y * (rowBytes + 1) + 1 + i] = val;
    });
  }

  const compressed = deflateSync(filtered, { level: 9 });

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace

  const ihdrChunk = createChunk('IHDR', ihdrData);
  const idatChunk = createChunk('IDAT', compressed);
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// Color type: [r, g, b, a]
type Color = [number, number, number, number];

function lerpColor(c1: Color, c2: Color, t: number): Color {
  const tc = Math.max(0, Math.min(1, t));
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * tc),
    Math.round(c1[1] + (c2[1] - c1[1]) * tc),
    Math.round(c1[2] + (c2[2] - c1[2]) * tc),
    Math.round(c1[3] + (c2[3] - c1[3]) * tc)
  ];
}

function blend(bg: Color, fg: Color): Color {
  const alpha = fg[3] / 255;
  const invAlpha = 1 - alpha;
  return [
    Math.round(fg[0] * alpha + bg[0] * invAlpha),
    Math.round(fg[1] * alpha + bg[1] * invAlpha),
    Math.round(fg[2] * alpha + bg[2] * invAlpha),
    Math.min(255, Math.round(fg[3] + bg[3] * invAlpha))
  ];
}

class Canvas {
  width: number;
  height: number;
  data: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
  }

  setPixel(x: number, y: number, color: Color) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const idx = (y * this.width + x) * 4;
    if (color[3] === 255) {
      this.data[idx] = color[0];
      this.data[idx + 1] = color[1];
      this.data[idx + 2] = color[2];
      this.data[idx + 3] = color[3];
    } else if (color[3] > 0) {
      const bg: Color = [this.data[idx], this.data[idx + 1], this.data[idx + 2], this.data[idx + 3]];
      const res = blend(bg, color);
      this.data[idx] = res[0];
      this.data[idx + 1] = res[1];
      this.data[idx + 2] = res[2];
      this.data[idx + 3] = res[3];
    }
  }

  fillGradient(topColor: Color, bottomColor: Color) {
    for (let y = 0; y < this.height; y++) {
      const t = y / (this.height - 1);
      const col = lerpColor(topColor, bottomColor, t);
      for (let x = 0; x < this.width; x++) {
        const idx = (y * this.width + x) * 4;
        this.data[idx] = col[0];
        this.data[idx + 1] = col[1];
        this.data[idx + 2] = col[2];
        this.data[idx + 3] = 255;
      }
    }
  }

  fillCircle(cx: number, cy: number, radius: number, color: Color) {
    const xmin = Math.max(0, Math.floor(cx - radius - 1));
    const xmax = Math.min(this.width - 1, Math.ceil(cx + radius + 1));
    const ymin = Math.max(0, Math.floor(cy - radius - 1));
    const ymax = Math.min(this.height - 1, Math.ceil(cy + radius + 1));

    const r2 = radius * radius;
    for (let y = ymin; y <= ymax; y++) {
      for (let x = xmin; x <= xmax; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const dist2 = dx * dx + dy * dy;
        if (dist2 <= r2) {
          const dist = Math.sqrt(dist2);
          let alpha = color[3];
          if (radius > 1 && dist > radius - 1) {
            alpha = Math.round(color[3] * (radius - dist));
          }
          if (alpha > 0) {
            this.setPixel(x, y, [color[0], color[1], color[2], alpha]);
          }
        }
      }
    }
  }

  fillEllipse(cx: number, cy: number, rx: number, ry: number, color: Color) {
    const xmin = Math.max(0, Math.floor(cx - rx - 1));
    const xmax = Math.min(this.width - 1, Math.ceil(cx + rx + 1));
    const ymin = Math.max(0, Math.floor(cy - ry - 1));
    const ymax = Math.min(this.height - 1, Math.ceil(cy + ry + 1));

    for (let y = ymin; y <= ymax; y++) {
      for (let x = xmin; x <= xmax; x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        const val = dx * dx + dy * dy;
        if (val <= 1.0) {
          let alpha = color[3];
          const edgeDist = 1.0 - Math.sqrt(val);
          if (edgeDist < 0.05 && rx > 5) {
            alpha = Math.round(color[3] * (edgeDist / 0.05));
          }
          if (alpha > 0) {
            this.setPixel(x, y, [color[0], color[1], color[2], alpha]);
          }
        }
      }
    }
  }

  fillPolygon(points: [number, number][], color: Color) {
    if (points.length < 3) return;
    let minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    const ymin = Math.max(0, Math.floor(minY));
    const ymax = Math.min(this.height - 1, Math.ceil(maxY));

    for (let y = ymin; y <= ymax; y++) {
      const nodes: number[] = [];
      let j = points.length - 1;
      for (let i = 0; i < points.length; i++) {
        const xi = points[i][0], yi = points[i][1];
        const xj = points[j][0], yj = points[j][1];
        if ((yi < y && yj >= y) || (yj < y && yi >= y)) {
          nodes.push(xi + ((y - yi) / (yj - yi)) * (xj - xi));
        }
        j = i;
      }
      nodes.sort((a, b) => a - b);
      for (let i = 0; i < nodes.length; i += 2) {
        if (i + 1 >= nodes.length) break;
        const xstart = Math.max(0, Math.ceil(nodes[i]));
        const xend = Math.min(this.width - 1, Math.floor(nodes[i + 1]));
        for (let x = xstart; x <= xend; x++) {
          this.setPixel(x, y, color);
        }
      }
    }
  }

  drawStar(cx: number, cy: number, r: number, color: Color) {
    const points: [number, number][] = [];
    const ptsCount = 4;
    for (let i = 0; i < ptsCount * 2; i++) {
      const angle = (i * Math.PI) / ptsCount - Math.PI / 2;
      const rad = i % 2 === 0 ? r : r * 0.35;
      points.push([cx + Math.cos(angle) * rad, cy + Math.sin(angle) * rad]);
    }
    this.fillPolygon(points, color);
  }

  drawHeart(cx: number, cy: number, size: number, color: Color) {
    const r = size * 0.3;
    this.fillCircle(cx - r, cy - r * 0.5, r, color);
    this.fillCircle(cx + r, cy - r * 0.5, r, color);
    this.fillPolygon([
      [cx - size * 0.6, cy - r * 0.3],
      [cx + size * 0.6, cy - r * 0.3],
      [cx, cy + size * 0.7]
    ], color);
  }
}

function renderCutePicture(): Buffer {
  const canvas = new Canvas(WIDTH, HEIGHT);

  // 1. Dreamy pastel background gradient (warm pink to lavender-blue)
  const topBg: Color = [255, 235, 245, 255];
  const botBg: Color = [215, 225, 255, 255];
  canvas.fillGradient(topBg, botBg);

  // 2. Glowing soft bokeh background circles
  const bokehColors: Color[] = [
    [255, 255, 255, 75],
    [255, 210, 230, 60],
    [210, 230, 255, 80]
  ];
  const bokehSpots = [
    [180, 160, 90], [840, 220, 110], [160, 820, 130], [820, 780, 100],
    [512, 120, 70], [120, 460, 80], [910, 500, 95], [420, 880, 120],
    [320, 350, 65], [700, 620, 75]
  ];
  for (let i = 0; i < bokehSpots.length; i++) {
    const [bx, by, br] = bokehSpots[i];
    canvas.fillCircle(bx, by, br, bokehColors[i % bokehColors.length]);
  }

  // 3. Floating sparkling stars & glowing hearts
  const starColor: Color = [255, 255, 230, 240];
  const heartColor: Color = [255, 130, 170, 220];
  canvas.drawStar(200, 260, 22, starColor);
  canvas.drawStar(840, 230, 26, starColor);
  canvas.drawStar(160, 740, 18, starColor);
  canvas.drawStar(860, 700, 24, starColor);
  canvas.drawStar(512, 200, 16, starColor);

  canvas.drawHeart(760, 300, 40, heartColor);
  canvas.drawHeart(220, 620, 35, heartColor);
  canvas.drawHeart(512, 850, 30, heartColor);

  // 4. MAIN SUBJECT: Super Cute Fluffy Pastel Kitty with Collar & Bell
  const cx = 512;
  const cy = 550;

  // Body
  const bodyColor: Color = [255, 250, 245, 255];
  const bodyShadow: Color = [240, 225, 215, 255];

  // Sitting body base
  canvas.fillEllipse(cx, cy + 130, 190, 170, bodyShadow);
  canvas.fillEllipse(cx, cy + 120, 180, 160, bodyColor);

  // Chubby Paws at bottom
  canvas.fillCircle(cx - 80, cy + 230, 38, bodyColor);
  canvas.fillCircle(cx + 80, cy + 230, 38, bodyColor);
  const pawPadColor: Color = [255, 170, 195, 255];
  canvas.fillCircle(cx - 80, cy + 236, 13, pawPadColor);
  canvas.fillCircle(cx + 80, cy + 236, 13, pawPadColor);

  // Cute Arms resting
  canvas.fillEllipse(cx - 115, cy + 110, 42, 28, bodyColor);
  canvas.fillEllipse(cx + 115, cy + 110, 42, 28, bodyColor);

  // Head
  const headRadius = 220;
  const headCenterY = cy - 30;
  canvas.fillCircle(cx, headCenterY + 12, headRadius + 10, bodyShadow);
  canvas.fillCircle(cx, headCenterY, headRadius, bodyColor);

  // Cat Ears
  const earColor: Color = [255, 235, 225, 255];
  const innerEarColor: Color = [255, 160, 185, 255];

  // Left ear
  canvas.fillPolygon([
    [cx - 190, headCenterY - 90],
    [cx - 90, headCenterY - 250],
    [cx - 45, headCenterY - 125]
  ], earColor);
  canvas.fillPolygon([
    [cx - 170, headCenterY - 100],
    [cx - 100, headCenterY - 220],
    [cx - 75, headCenterY - 135]
  ], innerEarColor);

  // Right ear
  canvas.fillPolygon([
    [cx + 45, headCenterY - 125],
    [cx + 90, headCenterY - 250],
    [cx + 190, headCenterY - 90]
  ], earColor);
  canvas.fillPolygon([
    [cx + 75, headCenterY - 135],
    [cx + 100, headCenterY - 220],
    [cx + 170, headCenterY - 100]
  ], innerEarColor);

  // Collar & Golden Bell around neck
  const collarColor: Color = [255, 105, 140, 255];
  canvas.fillEllipse(cx, headCenterY + 160, 130, 28, collarColor);
  // Golden Bell
  const bellGold: Color = [255, 215, 0, 255];
  const bellDark: Color = [200, 160, 0, 255];
  canvas.fillCircle(cx, headCenterY + 185, 22, bellDark);
  canvas.fillCircle(cx, headCenterY + 180, 20, bellGold);
  canvas.fillCircle(cx, headCenterY + 178, 6, [100, 80, 0, 255]);
  // Vertical slit on bell
  for (let y = headCenterY + 180; y <= headCenterY + 192; y++) {
    canvas.setPixel(cx, y, [120, 90, 0, 255]);
  }

  // Rosy Cheeks (blush)
  const blushColor: Color = [255, 140, 170, 160];
  canvas.fillEllipse(cx - 120, headCenterY + 60, 48, 28, blushColor);
  canvas.fillEllipse(cx + 120, headCenterY + 60, 48, 28, blushColor);

  // Big Shiny Anime Eyes
  const eyeColor: Color = [35, 25, 40, 255];
  const eyeRx = 45;
  const eyeRy = 60;
  const leftEyeX = cx - 80;
  const rightEyeX = cx + 80;
  const eyeY = headCenterY;

  canvas.fillEllipse(leftEyeX, eyeY, eyeRx, eyeRy, eyeColor);
  canvas.fillEllipse(rightEyeX, eyeY, eyeRx, eyeRy, eyeColor);

  // Magical Eye Highlights
  const white: Color = [255, 255, 255, 255];
  const cyanTint: Color = [190, 230, 255, 255];

  // Left eye
  canvas.fillCircle(leftEyeX - 14, eyeY - 20, 18, white);
  canvas.fillCircle(leftEyeX + 14, eyeY + 20, 9, white);
  canvas.fillCircle(leftEyeX - 10, eyeY + 12, 6, cyanTint);

  // Right eye
  canvas.fillCircle(rightEyeX - 14, eyeY - 20, 18, white);
  canvas.fillCircle(rightEyeX + 14, eyeY + 20, 9, white);
  canvas.fillCircle(rightEyeX - 10, eyeY + 12, 6, cyanTint);

  // Tiny Cute Nose
  const noseColor: Color = [220, 110, 135, 255];
  canvas.fillPolygon([
    [cx, eyeY + 32],
    [cx - 11, eyeY + 19],
    [cx + 11, eyeY + 19]
  ], noseColor);

  // Smiling 'w' Mouth
  const mouthColor: Color = [110, 60, 70, 255];
  canvas.fillCircle(cx - 16, eyeY + 48, 4, mouthColor);
  canvas.fillCircle(cx + 16, eyeY + 48, 4, mouthColor);
  canvas.fillCircle(cx, eyeY + 52, 5, mouthColor);
  canvas.fillCircle(cx - 8, eyeY + 50, 4, mouthColor);
  canvas.fillCircle(cx + 8, eyeY + 50, 4, mouthColor);

  // Whiskers
  const whiskerColor: Color = [170, 140, 150, 210];
  for (let dy = -8; dy <= 8; dy += 8) {
    for (let x = cx - 170; x <= cx - 120; x++) {
      const t = (x - (cx - 170)) / 50;
      const y = Math.round(eyeY + 38 + dy + t * (dy * 0.4));
      canvas.setPixel(x, y, whiskerColor);
      canvas.setPixel(x, y + 1, whiskerColor);
    }
    for (let x = cx + 120; x <= cx + 170; x++) {
      const t = ((cx + 170) - x) / 50;
      const y = Math.round(eyeY + 38 + dy + t * (dy * 0.4));
      canvas.setPixel(x, y, whiskerColor);
      canvas.setPixel(x, y + 1, whiskerColor);
    }
  }

  // Cute Bow on Top of Head
  const bowColor: Color = [255, 90, 130, 255];
  const bowY = headCenterY - 190;
  canvas.fillCircle(cx, bowY, 16, bowColor);
  canvas.fillPolygon([
    [cx, bowY],
    [cx - 35, bowY - 20],
    [cx - 35, bowY + 20]
  ], bowColor);
  canvas.fillPolygon([
    [cx, bowY],
    [cx + 35, bowY - 20],
    [cx + 35, bowY + 20]
  ], bowColor);
  canvas.fillCircle(cx, bowY, 7, [255, 255, 255, 255]);

  return encodePNG(canvas.data, WIDTH, HEIGHT);
}

function main() {
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  mkdirSync(outputDir, { recursive: true });
  const pngBuffer = renderCutePicture();
  const outputPath = join(outputDir, 'entry.png');
  writeFileSync(outputPath, pngBuffer);
  console.log(`Successfully generated cutest picture at ${outputPath} (${pngBuffer.length} bytes)`);
}

main();
