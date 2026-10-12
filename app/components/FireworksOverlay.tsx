"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

const COLORS = ["#8b43d6", "#d4479c", "#6941c6", "#ed9b27", "#ae66df"];

/** A short, non-interactive celebration that survives the card changing buckets. */
export function FireworksOverlay({ onDone }: { onDone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (motion.matches || !canvas || !ctx) { onDone(); return; }

    let width = innerWidth;
    let height = innerHeight;
    let frame = 0;
    let stopped = false;
    const resize = () => {
      width = innerWidth;
      height = innerHeight;
      const ratio = Math.min(devicePixelRatio || 1, 2);
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);
    const stopForMotion = () => { if (motion.matches) { stopped = true; cancelAnimationFrame(frame); onDone(); } };
    motion.addEventListener("change", stopForMotion);

    const bursts = [
      { x: .2, y: .28, delay: 0 },
      { x: .8, y: .3, delay: 130 },
      { x: .5, y: .43, delay: 240 },
      { x: .3, y: .63, delay: 390 },
      { x: .74, y: .66, delay: 490 },
    ].map((burst, i) => ({ ...burst, particles: Array.from({ length: 32 }, (_, j) => ({
      angle: j * Math.PI * 2 / 32 + i * .2,
      speed: 110 + (j % 4) * 30,
      color: COLORS[(i + j) % COLORS.length],
    })) }));
    const start = performance.now();
    const draw = (now: number) => {
      if (stopped) return;
      const elapsed = now - start;
      ctx.clearRect(0, 0, width, height);
      for (const burst of bursts) {
        const age = (elapsed - burst.delay) / 1000;
        if (age < 0 || age > 1.1) continue;
        const progress = age / 1.1;
        const radius = Math.min(width, height) * .22;
        for (const particle of burst.particles) {
          const travel = radius * (1 - Math.exp(-age * 3)) * particle.speed / 160;
          const x = burst.x * width + Math.cos(particle.angle) * travel;
          const y = burst.y * height + Math.sin(particle.angle) * travel + 65 * age * age;
          ctx.globalAlpha = Math.pow(1 - progress, 1.3);
          ctx.strokeStyle = particle.color;
          ctx.fillStyle = particle.color;
          ctx.lineWidth = 2.5 * (1 - progress) + .5;
          ctx.beginPath();
          ctx.moveTo(x - Math.cos(particle.angle) * 9 * (1 - progress), y - Math.sin(particle.angle) * 9 * (1 - progress));
          ctx.lineTo(x, y);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(x, y, 2.5 * (1 - progress) + .5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      if (elapsed < 1700) frame = requestAnimationFrame(draw);
      else onDone();
    };
    frame = requestAnimationFrame(draw);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      motion.removeEventListener("change", stopForMotion);
    };
  }, [onDone]);

  return typeof document === "undefined" ? null : createPortal(
    <canvas ref={canvasRef} className="fireworks-overlay" aria-hidden="true" />,
    document.body,
  );
}
