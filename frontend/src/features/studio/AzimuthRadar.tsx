/* Azimuth radar — faithful port of drawAzRadar + radarClickToAz
   (app.js:1198-1209, 1239-1302). Internal resolution 240x200 scaled by
   devicePixelRatio; CSS scales the canvas to the container width and the
   click mapping compensates for it. Every color comes from the --radar-*
   theme tokens via readCssVar, and the canvas redraws on theme flips
   (refreshThemedJsColors semantics, app.js:172-179). */

import { useEffect, useRef } from 'react';
import type { MouseEvent } from 'react';
import { readCssVar, useTheme } from '../../hooks/useTheme';
import type { Speaker } from '../../lib/types';

const W = 240;
const H = 200;

/** Smallest absolute angular separation (degrees) between two azimuths,
 *  correct across the +/-180 deg wrap (app.js:1099-1102). */
export function azSep(a: number, b: number): number {
  const d = ((((a - b + 180) % 360) + 360) % 360) - 180;
  return Math.abs(d);
}

/** Normalise an azimuth to a rounded value in [-180, 180). */
export function normAz(az: number): number {
  return Math.round(((((az + 180) % 360) + 360) % 360) - 180);
}

/** Map a click on the radar to an azimuth in [-180, 180), or null when the
 *  click is too near the centre (ambiguous). Maps client coords through the
 *  CSS scale back onto the logical 240x200 grid (app.js:1198-1209). */
function clickToAz(canvas: HTMLCanvasElement, evt: MouseEvent<HTMLCanvasElement>): number | null {
  const rect = canvas.getBoundingClientRect();
  const x = (evt.clientX - rect.left) * (W / rect.width);
  const y = (evt.clientY - rect.top) * (H / rect.height);
  const dx = x - W / 2;
  const dy = y - H / 2;
  if (Math.hypot(dx, dy) < 8) return null;
  // inverse of draw(): screen angle = (az - 90) degrees
  const az = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  return normAz(az);
}

function draw(ctx: CanvasRenderingContext2D, speakers: Speaker[], targetAz: number | null): void {
  const c = {
    ring: readCssVar('--radar-ring'),
    spoke: readCssVar('--radar-spoke'),
    label: readCssVar('--radar-label'),
    hub: readCssVar('--radar-hub'),
    blip: readCssVar('--radar-blip'),
    target: readCssVar('--radar-target'),
    halo: readCssVar('--radar-target-halo'),
  };
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(cx, cy) - 10;
  ctx.clearRect(0, 0, W, H);
  // Background circle + 45-degree spokes
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, 2 * Math.PI);
  ctx.strokeStyle = c.ring;
  ctx.lineWidth = 1;
  ctx.stroke();
  for (let deg = 0; deg < 360; deg += 45) {
    const rad = ((deg - 90) * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.cos(rad), cy + R * Math.sin(rad));
    ctx.strokeStyle = c.spoke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  // "F" label (front, 0 degrees)
  ctx.fillStyle = c.label;
  ctx.font = '9px JetBrains Mono, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('F', cx, cy - R - 3);
  // Center dot (mic array)
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, 2 * Math.PI);
  ctx.fillStyle = c.hub;
  ctx.fill();
  // Detected speakers: blip radius scales with strength
  let targetMatched = false;
  speakers.forEach((sp) => {
    const isTarget = targetAz != null && azSep(sp.az, targetAz) < 1.0;
    if (isTarget) targetMatched = true;
    const rad = ((sp.az - 90) * Math.PI) / 180;
    const r = R * (0.55 + 0.35 * (sp.strength || 0.5));
    const x = cx + r * Math.cos(rad);
    const y = cy + r * Math.sin(rad);
    // Line from center
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
    ctx.strokeStyle = isTarget ? c.target : c.hub;
    ctx.lineWidth = isTarget ? 2 : 1;
    ctx.stroke();
    // Dot
    ctx.beginPath();
    ctx.arc(x, y, isTarget ? 6 : 4, 0, 2 * Math.PI);
    ctx.fillStyle = isTarget ? c.target : c.blip;
    ctx.fill();
    if (isTarget) {
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, 2 * Math.PI);
      ctx.strokeStyle = c.halo;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  });
  // Manual aim that isn't one of the detected talkers: draw its own marker at
  // 0.85R so a radar-click target is always visible.
  if (targetAz != null && !targetMatched) {
    const rad = ((targetAz - 90) * Math.PI) / 180;
    const x = cx + R * 0.85 * Math.cos(rad);
    const y = cy + R * 0.85 * Math.sin(rad);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
    ctx.strokeStyle = c.target;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, 2 * Math.PI);
    ctx.fillStyle = c.target;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, 2 * Math.PI);
    ctx.strokeStyle = c.halo;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  // Hint when nothing is aimed/detected.
  if (speakers.length === 0 && targetAz == null) {
    ctx.fillStyle = c.label;
    ctx.font = '8px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('click to aim', cx, cy + R + 9);
  }
}

interface Props {
  speakers: Speaker[];
  targetAz: number | null;
  /** Raw clicked azimuth — the owner applies the 8-degree snap-to-talker. */
  onAim: (az: number) => void;
}

export default function AzimuthRadar({ speakers, targetAz, onAim }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { mode } = useTheme();

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, speakers, targetAz);
  }, [speakers, targetAz, mode]);

  return (
    <canvas
      ref={ref}
      width={W}
      height={H}
      className="az-radar"
      title="Click to aim the beam at any direction"
      onClick={(e) => {
        const canvas = ref.current;
        if (!canvas) return;
        const az = clickToAz(canvas, e);
        if (az == null) return;
        onAim(az);
      }}
    />
  );
}
