/**
 * Zero-dependency ISO/IEC 18004 QR Code encoder (Byte mode, ECC Level M, Versions 1-12).
 * Supports UTF-8 payloads up to 287 bytes and builds compact SVG `<path>` geometry locally.
 */

export interface QrMatrix {
  version: number;
  size: number;
  mask: number;
  modules: Uint8Array;
}

export interface QrSvgGeometry {
  version: number;
  size: number;
  quietZone: number;
  viewBoxSize: number;
  pathData: string;
}

// ISO/IEC 18004 Table 9 for ECC Level M (format EC bits = 0b00), Versions 1..12:
// [ecCodewordsPerBlock, numBlocks, totalDataCodewords]
const ECC_M: ReadonlyArray<readonly [number, number, number]> = [
  [10, 1, 16],
  [16, 1, 28],
  [26, 1, 44],
  [18, 2, 64],
  [24, 2, 86],
  [16, 4, 108],
  [18, 4, 124],
  [22, 4, 154],
  [22, 5, 182],
  [26, 5, 216],
  [30, 5, 254],
  [22, 8, 290],
];

function gfMul(a: number, b: number): number {
  let x = a;
  let y = b;
  let r = 0;
  for (let i = 0; i < 8; i++) {
    if (y & 1) r ^= x;
    const hi = x & 0x80;
    x = (x << 1) & 0xff;
    if (hi) x ^= 0x1d;
    y >>>= 1;
  }
  return r;
}

function rsDivisor(deg: number): Uint8Array {
  const res = new Uint8Array(deg);
  res[deg - 1] = 1;
  let root = 1;
  for (let i = 0; i < deg; i++) {
    for (let j = 0; j < deg; j++) {
      res[j] = gfMul(res[j]!, root) ^ (j + 1 < deg ? res[j + 1]! : 0);
    }
    root = gfMul(root, 2);
  }
  return res;
}

function rsRemainder(data: Uint8Array, div: Uint8Array): Uint8Array {
  const res = new Uint8Array(div.length);
  for (let i = 0; i < data.length; i++) {
    const f = data[i]! ^ res[0]!;
    res.copyWithin(0, 1);
    res[res.length - 1] = 0;
    for (let j = 0; j < div.length; j++) {
      res[j] = res[j]! ^ gfMul(div[j]!, f);
    }
  }
  return res;
}

function selectVersion(byteLen: number): number {
  for (let v = 1; v <= ECC_M.length; v++) {
    const needed = 4 + (v >= 10 ? 16 : 8) + byteLen * 8;
    if (needed <= ECC_M[v - 1]![2] * 8) return v;
  }
  throw new Error(`QR payload too long (${byteLen} bytes; max 287 bytes at ECC-M)`);
}

function encodeData(bytes: Uint8Array, version: number): Uint8Array {
  const dataCw = ECC_M[version - 1]![2];
  const capBits = dataCw * 8;
  const bits: number[] = [];
  const push = (val: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version >= 10 ? 16 : 8);
  for (let i = 0; i < bytes.length; i++) push(bytes[i]!, 8);
  for (let i = Math.min(4, capBits - bits.length); i > 0; i--) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const out = new Uint8Array(dataCw);
  const used = bits.length / 8;
  for (let i = 0; i < used; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j]!;
    out[i] = b;
  }
  for (let i = used; i < dataCw; i++) {
    out[i] = (i - used) % 2 === 0 ? 0xec : 0x11;
  }
  return out;
}

function interleaveEcc(data: Uint8Array, version: number): Uint8Array {
  const [ecLen, numBlocks, totalDataCw] = ECC_M[version - 1]!;
  const totalCw = totalDataCw + ecLen * numBlocks;
  const numShort = numBlocks - (totalCw % numBlocks);
  const shortData = Math.floor(totalCw / numBlocks) - ecLen;
  const div = rsDivisor(ecLen);

  const dBlocks: Uint8Array[] = [];
  const eBlocks: Uint8Array[] = [];
  let off = 0;
  for (let i = 0; i < numBlocks; i++) {
    const len = i < numShort ? shortData : shortData + 1;
    const blk = data.subarray(off, off + len);
    off += len;
    dBlocks.push(blk);
    eBlocks.push(rsRemainder(blk, div));
  }

  const out = new Uint8Array(totalCw);
  let k = 0;
  const maxData = numShort === numBlocks ? shortData : shortData + 1;
  for (let i = 0; i < maxData; i++) {
    for (let j = 0; j < numBlocks; j++) {
      if (i < dBlocks[j]!.length) out[k++] = dBlocks[j]![i]!;
    }
  }
  for (let i = 0; i < ecLen; i++) {
    for (let j = 0; j < numBlocks; j++) out[k++] = eBlocks[j]![i]!;
  }
  return out;
}

function drawFormat(
  modules: Uint8Array,
  isFn: Uint8Array,
  size: number,
  mask: number,
): void {
  let rem = mask; // EC Level M bits = 0b00
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537);
  const bits = ((mask << 10) | rem) ^ 0x5412;
  const set = (x: number, y: number, dark: boolean): void => {
    const idx = y * size + x;
    modules[idx] = dark ? 1 : 0;
    isFn[idx] = 1;
  };
  for (let i = 0; i <= 5; i++) set(8, i, ((bits >>> i) & 1) !== 0);
  set(8, 7, ((bits >>> 6) & 1) !== 0);
  set(8, 8, ((bits >>> 7) & 1) !== 0);
  set(7, 8, ((bits >>> 8) & 1) !== 0);
  for (let i = 9; i < 15; i++) set(14 - i, 8, ((bits >>> i) & 1) !== 0);
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, ((bits >>> i) & 1) !== 0);
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, ((bits >>> i) & 1) !== 0);
  set(8, size - 8, true);
}

function createMatrix(version: number): {
  size: number;
  modules: Uint8Array;
  isFn: Uint8Array;
} {
  const size = version * 4 + 17;
  const modules = new Uint8Array(size * size);
  const isFn = new Uint8Array(size * size);
  const set = (x: number, y: number, dark: boolean): void => {
    const idx = y * size + x;
    modules[idx] = dark ? 1 : 0;
    isFn[idx] = 1;
  };

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          set(x, y, d !== 2 && d !== 4);
        }
      }
    }
  }

  const centers =
    version === 1
      ? []
      : version < 7
        ? [6, version * 4 + 10]
        : [6, version * 2 + 8, version * 4 + 10];
  for (let i = 0; i < centers.length; i++) {
    for (let j = 0; j < centers.length; j++) {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === centers.length - 1) ||
        (i === centers.length - 1 && j === 0)
      ) {
        continue;
      }
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(centers[i]! + dx, centers[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  drawFormat(modules, isFn, size, 0);

  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ (((rem >>> 11) & 1) * 0x1f25);
    const vBits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((vBits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  return { size, modules, isFn };
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function penaltyOf(modules: Uint8Array, size: number): number {
  let pen = 0;
  let dark = 0;

  // Rules 1 & 3 along rows and columns via 11-bit sliding mask (10111010000 = 0x5d0, 00001011101 = 0x05d)
  for (let dir = 0; dir < 2; dir++) {
    for (let a = 0; a < size; a++) {
      let runColor = -1;
      let runLen = 0;
      let pat = 0;
      for (let b = 0; b < size; b++) {
        const c = modules[dir === 0 ? a * size + b : b * size + a]!;
        if (dir === 0) dark += c;
        if (c === runColor) {
          runLen += 1;
          if (runLen === 5) pen += 3;
          else if (runLen > 5) pen += 1;
        } else {
          runColor = c;
          runLen = 1;
        }
        pat = ((pat << 1) | c) & 0x7ff;
        if (b >= 10 && (pat === 0x5d0 || pat === 0x05d)) pen += 40;
      }
    }
  }

  // Rule 2: 2x2 uniform blocks
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y * size + x]!;
      if (
        c === modules[y * size + x + 1]! &&
        c === modules[(y + 1) * size + x]! &&
        c === modules[(y + 1) * size + x + 1]!
      ) {
        pen += 3;
      }
    }
  }

  // Rule 4: dark ratio balance
  const total = size * size;
  pen += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return pen;
}

export function encodeQrMatrix(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const version = selectVersion(bytes.length);
  const cw = interleaveEcc(encodeData(bytes, version), version);
  const { size, modules, isFn } = createMatrix(version);

  let bitIdx = 0;
  const totalBits = cw.length * 8;
  let up = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const y = up ? size - 1 - step : step;
      for (let colOff = 0; colOff < 2; colOff++) {
        const idx = y * size + (right - colOff);
        if (isFn[idx] === 1) continue;
        modules[idx] =
          bitIdx < totalBits
            ? (cw[bitIdx >>> 3]! >>> (7 - (bitIdx & 7))) & 1
            : 0;
        bitIdx += 1;
      }
    }
    up = !up;
  }

  let bestMask = 0;
  let bestPen = Infinity;
  let bestMod = modules;
  for (let m = 0; m < 8; m++) {
    const cand = new Uint8Array(modules);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = y * size + x;
        if (isFn[idx] === 0 && maskBit(m, x, y)) cand[idx] = cand[idx]! ^ 1;
      }
    }
    drawFormat(cand, isFn, size, m);
    const p = penaltyOf(cand, size);
    if (p < bestPen) {
      bestPen = p;
      bestMask = m;
      bestMod = cand;
    }
  }

  return { version, size, mask: bestMask, modules: bestMod };
}

export function buildQrSvgGeometry(text: string, quietZone = 4): QrSvgGeometry {
  const { version, size, modules } = encodeQrMatrix(text);
  const segs: string[] = [];
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (modules[y * size + x] === 1) {
        const start = x;
        while (x < size && modules[y * size + x] === 1) x += 1;
        const run = x - start;
        segs.push(`M${start + quietZone} ${y + quietZone}h${run}v1h-${run}z`);
      } else {
        x += 1;
      }
    }
  }
  return {
    version,
    size,
    quietZone,
    viewBoxSize: size + quietZone * 2,
    pathData: segs.join(""),
  };
}
