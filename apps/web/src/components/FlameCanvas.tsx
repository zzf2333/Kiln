import { useEffect, useRef } from "react";

const FIRE_STOPS: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [0.0, 255, 252, 240, 1.0],
  [0.1, 255, 240, 170, 1.0],
  [0.28, 253, 196, 70, 0.95],
  [0.5, 245, 128, 32, 0.8],
  [0.72, 205, 70, 16, 0.5],
  [1.0, 90, 20, 8, 0],
];

const LIGHT_FIRE_STOPS: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [0.0, 255, 244, 180, 0.95],
  [0.14, 245, 158, 11, 0.92],
  [0.36, 234, 88, 12, 0.85],
  [0.62, 194, 52, 10, 0.6],
  [0.85, 140, 32, 8, 0.28],
  [1.0, 90, 20, 8, 0],
];

function fireColor(
  t: number,
  stops: ReadonlyArray<readonly [number, number, number, number, number]> = FIRE_STOPS,
): [number, number, number, number] {
  for (let i = 1; i < stops.length; i += 1) {
    const hi = stops[i]!;
    if (t <= hi[0]) {
      const lo = stops[i - 1]!;
      const k = (t - lo[0]) / (hi[0] - lo[0]);
      return [
        lo[1] + (hi[1] - lo[1]) * k,
        lo[2] + (hi[2] - lo[2]) * k,
        lo[3] + (hi[3] - lo[3]) * k,
        lo[4] + (hi[4] - lo[4]) * k,
      ];
    }
  }
  return [90, 20, 8, 0];
}

let cachedSprites: HTMLCanvasElement[] | null = null;
let cachedLightSprites: HTMLCanvasElement[] | null = null;

function buildSprites(
  stops: ReadonlyArray<readonly [number, number, number, number, number]>,
): HTMLCanvasElement[] | null {
  if (typeof document === "undefined") return null;
  const list: HTMLCanvasElement[] = [];
  for (let i = 0; i < 32; i += 1) {
    const [r, g, b] = fireColor(i / 31, stops);
    const ri = r | 0;
    const gi = g | 0;
    const bi = b | 0;
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext("2d");
    if (!ctx) {
      return null;
    }
    const gr = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, `rgba(${ri}, ${gi}, ${bi}, 1)`);
    gr.addColorStop(0.3, `rgba(${ri}, ${gi}, ${bi}, 0.6)`);
    gr.addColorStop(0.65, `rgba(${ri}, ${gi}, ${bi}, 0.15)`);
    gr.addColorStop(1, `rgba(${ri}, ${gi}, ${bi}, 0)`);
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, 64, 64);
    list.push(c);
  }
  return list;
}

function getSprites(isLight: boolean): HTMLCanvasElement[] | null {
  if (isLight) {
    if (!cachedLightSprites) {
      cachedLightSprites = buildSprites(LIGHT_FIRE_STOPS);
    }
    return cachedLightSprites;
  }
  if (!cachedSprites) {
    cachedSprites = buildSprites(FIRE_STOPS);
  }
  return cachedSprites;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  s: number;
  seed: number;
  spark: boolean;
  age: number;
}

function spawnFlame(
  ps: Particle[],
  W: number,
  H: number,
  up: number,
  pad: number,
  sm: boolean,
  heat: number,
): void {
  const u = Math.pow(Math.random(), 0.55);
  const spark = Math.random() < (sm ? 0.05 : 0.09);
  const k = sm ? 0.45 : 1;
  ps.push({
    x: pad + W * u + (Math.random() - 0.5) * 4,
    y: up + H / 2 + (Math.random() - 0.5) * H * 0.8,
    vx: -(6 + Math.random() * 18) * k,
    vy: -(spark ? 50 + Math.random() * 60 : 12 + Math.random() * 26) * k,
    life: spark ? 0.8 + Math.random() * 0.9 : (0.4 + Math.random() * 0.55) * (sm ? 0.75 : 1),
    s: spark
      ? 0.7 + Math.random() * 0.8
      : ((sm ? 2.6 : 5) + Math.random() * (sm ? 2.4 : 6)) *
        (0.55 + 0.75 * u) *
        (0.85 + heat * 0.25),
    seed: Math.random() * 6.28,
    spark,
    age: 0,
  });
}

export interface FlameCanvasProps {
  size?: "sm" | "default";
  heat: number;
}

export function FlameCanvas({ size = "default", heat }: FlameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef({ sm: size === "sm", heat });
  propsRef.current = { sm: size === "sm", heat };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (
      typeof window === "undefined" ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ||
      typeof window.requestAnimationFrame !== "function"
    ) {
      return;
    }

    const ctx = canvas.getContext("2d");
    const darkSprites = getSprites(false);
    const lightSprites = getSprites(true);
    if (!ctx || !darkSprites || !lightSprites) return;

    let rafId = 0;
    let disposed = false;
    let ps: Particle[] = [];
    let lastTs = performance.now();
    let acc = 0;

    const frame = (ts: number): void => {
      if (disposed) return;
      const host = canvas.parentElement;
      if (!host) return;

      const isLight =
        typeof document !== "undefined" && document.documentElement.dataset.theme === "light";
      const spr = isLight ? lightSprites : darkSprites;
      const activeStops = isLight ? LIGHT_FIRE_STOPS : FIRE_STOPS;

      const { sm, heat: currentHeat } = propsRef.current;
      const W = host.clientWidth;
      const H = host.clientHeight;

      if (W > 0 && H > 0) {
        const up = sm ? 18 : 46;
        const pad = sm ? 12 : 34;
        const cw = W + pad * 2;
        const ch = H + up + (sm ? 8 : 16);
        const dpr = window.devicePixelRatio || 1;
        const targetW = Math.round(cw * dpr);
        const targetH = Math.round(ch * dpr);

        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
          canvas.style.width = `${cw}px`;
          canvas.style.height = `${ch}px`;
          canvas.style.left = `${-pad}px`;
          canvas.style.bottom = `${-(sm ? 8 : 16)}px`;
        }

        const dt = Math.min(0.05, Math.max(0, (ts - lastTs) / 1000));
        lastTs = ts;
        acc += (sm ? 55 : 115) * currentHeat * Math.max(0.6, Math.min(3.5, W / 80)) * dt;
        while (acc >= 1) {
          acc -= 1;
          spawnFlame(ps, W, H, up, pad, sm, currentHeat);
        }

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cw, ch);
        ctx.globalCompositeOperation = isLight ? "source-over" : "lighter";

        const lift = (sm ? 40 : 120) * (0.8 + currentHeat * 0.35);
        ps = ps.filter((p) => {
          p.age += dt;
          return p.age < p.life;
        });

        for (const p of ps) {
          const t = p.age / p.life;
          p.vy -= lift * dt;
          p.vx += Math.sin(ts / 140 + p.seed) * (sm ? 10 : 26) * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;

          if (p.spark) {
            const [r, g, b, a] = fireColor(Math.min(0.6, t * 0.6), activeStops);
            ctx.globalAlpha = 1;
            const alpha =
              a * Math.max(0, Math.min(1, p.y / (up * 0.5))) * (0.5 + Math.random() * 0.5);
            ctx.fillStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${alpha})`;
            ctx.fillRect(p.x, p.y, p.s, p.s);
            continue;
          }

          const edge = Math.max(0, Math.min(1, (p.y - 2) / (up * 0.65)));
          const a = fireColor(t, activeStops)[3] * edge;
          const s = p.s * (1 - t * 0.65);
          ctx.globalAlpha = Math.min(1, a * (isLight ? 0.72 : 0.62));
          const sprite = spr[Math.min(31, (t * 31) | 0)];
          if (sprite) {
            ctx.drawImage(sprite, p.x - s, p.y - s * 1.25, s * 2, s * 2.5);
          }
        }

        const hx = pad + W;
        const hy = up + H / 2;
        const f = 0.82 + Math.random() * 0.36;
        const R = (sm ? 7 : 18) * f * (0.85 + currentHeat * 0.25);
        ctx.globalAlpha = 0.9;
        if (spr[2]) ctx.drawImage(spr[2], hx - R, hy - R, R * 2, R * 2);
        ctx.globalAlpha = 0.5;
        if (spr[12]) {
          ctx.drawImage(spr[12], hx - R * 1.8, hy - R * 1.8, R * 3.6, R * 3.6);
        }
        ctx.globalAlpha = 1;
      } else {
        lastTs = ts;
      }

      rafId = window.requestAnimationFrame(frame);
    };

    rafId = window.requestAnimationFrame(frame);

    return () => {
      disposed = true;
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      ps = [];
      canvas.width = 0;
      canvas.height = 0;
    };
  }, []);

  return <canvas ref={canvasRef} className="fire-canvas" aria-hidden="true" />;
}
