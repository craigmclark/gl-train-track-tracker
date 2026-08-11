import { CROSSING_LAT, CROSSING_LON } from "./config";

/**
 * Solar altitude in degrees at the crossing, for a given instant.
 *
 * Used to pick the day or night reference frame. A fixed clock hour would be
 * wrong by hours across the year at this latitude (42.3N swings from ~9h to ~15h
 * of daylight), and the camera's IR/night mode switches with actual light, not
 * with the clock.
 *
 * Low-precision NOAA algorithm — accurate to a fraction of a degree, which is far
 * more than we need to answer "is it light out".
 */
export function solarAltitudeDeg(when: Date): number {
  const rad = Math.PI / 180;

  // Days since J2000.0
  const julian = when.getTime() / 86_400_000 + 2440587.5;
  const n = julian - 2451545.0;

  const meanLongitude = (280.46 + 0.9856474 * n) % 360;
  const meanAnomaly = ((357.528 + 0.9856003 * n) % 360) * rad;

  const eclipticLongitude =
    (meanLongitude +
      1.915 * Math.sin(meanAnomaly) +
      0.02 * Math.sin(2 * meanAnomaly)) *
    rad;

  const obliquity = (23.439 - 0.0000004 * n) * rad;

  const declination = Math.asin(
    Math.sin(obliquity) * Math.sin(eclipticLongitude),
  );

  let rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.cos(eclipticLongitude),
  );
  if (rightAscension < 0) rightAscension += 2 * Math.PI;

  // Greenwich mean sidereal time -> local hour angle
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const lmst = ((gmst * 15 + CROSSING_LON) % 360) * rad;
  const hourAngle = lmst - rightAscension;

  const lat = CROSSING_LAT * rad;
  const altitude = Math.asin(
    Math.sin(lat) * Math.sin(declination) +
      Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle),
  );

  return altitude / rad;
}

/**
 * Is there enough light for the camera's daytime mode?
 *
 * The threshold sits a little above the horizon rather than at 0: these cameras
 * flip to a noisy, glare-prone night mode around civil twilight, well before the
 * sun is geometrically down.
 */
export function isDaylight(when: Date): boolean {
  return solarAltitudeDeg(when) > 3;
}
