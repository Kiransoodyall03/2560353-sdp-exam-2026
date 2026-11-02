// Minimal astronomy for the target-elevation safeguard: GMST → local sidereal time → altitude.
// Pure functions over the envelope's simulated timestamp (unix ms). No epochs, no refraction:
// the 15° limit has plenty of margin for the ~arcminute error of this model.
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

/** Greenwich mean sidereal time in radians (0..2π) at a unix timestamp. */
export function gmstRad(unixMs: number): number {
  const jd = unixMs / 86_400_000 + 2_440_587.5;
  const t = (jd - 2_451_545) / 36_525;
  let deg = 280.46061837 + 360.98564736629 * (jd - 2_451_545) + 0.000387933 * t * t - (t * t * t) / 38_710_000;
  deg = ((deg % 360) + 360) % 360;
  return deg * DEG;
}

/** Local sidereal time in radians for an east-positive longitude in degrees. */
export function lstRad(unixMs: number, lonDeg: number): number {
  const v = gmstRad(unixMs) + lonDeg * DEG;
  return ((v % TAU) + TAU) % TAU;
}

/** Altitude above the horizon (radians) of a fixed sky position seen from lat/lon. */
export function altitudeRad(raRad: number, decRad: number, latDeg: number, lonDeg: number, unixMs: number): number {
  const lat = latDeg * DEG;
  const hourAngle = lstRad(unixMs, lonDeg) - raRad;
  const sinAlt = Math.sin(decRad) * Math.sin(lat) + Math.cos(decRad) * Math.cos(lat) * Math.cos(hourAngle);
  return Math.asin(Math.max(-1, Math.min(1, sinAlt)));
}

export function altitudeDeg(raRad: number, decRad: number, latDeg: number, lonDeg: number, unixMs: number): number {
  return altitudeRad(raRad, decRad, latDeg, lonDeg, unixMs) / DEG;
}
