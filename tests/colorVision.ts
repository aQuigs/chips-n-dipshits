/**
 * Enough color science to check that colors can be told apart: WCAG contrast, and the distance
 * between two colors as seen with normal vision and with each of the common kinds of color blindness.
 */

type Rgb = [number, number, number];
type Matrix = [Rgb, Rgb, Rgb];

/** Machado, Oliveira and Fernandes (2009) at full severity, applied to linear RGB. */
export const VISIONS: Record<string, Matrix> = {
  normal: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

function linear(hex: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) {
    throw new Error(`not a #rrggbb color: ${hex}`);
  }

  return [0, 2, 4].map((at) => {
    const channel = parseInt(match[1]!.slice(at, at + 2), 16) / 255;

    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
}

const luminance = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(linear(a)), luminance(linear(b))].sort((x, y) => y - x);

  return (light! + 0.05) / (dark! + 0.05);
}

function lab(rgb: Rgb): Rgb {
  const [r, g, b] = rgb.map((channel) => Math.min(1, Math.max(0, channel)));
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const x = f((0.4124 * r! + 0.3576 * g! + 0.1805 * b!) / 0.95047);
  const y = f(0.2126 * r! + 0.7152 * g! + 0.0722 * b!);
  const z = f((0.0193 * r! + 0.1192 * g! + 0.9505 * b!) / 1.08883);

  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** How far apart two colors look (CIELAB ΔE) to someone with the given vision. */
export function distance(a: string, b: string, vision: Matrix): number {
  const seen = (hex: string) => {
    const rgb = linear(hex);

    return lab(vision.map((row) => row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]) as Rgb);
  };
  const [p, q] = [seen(a), seen(b)];

  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
