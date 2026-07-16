'use strict';

/**
 * Pure geodesic helpers. No Leaflet, no DOM, no shared state — so the routing
 * layer that sits on top of this can be tested in isolation.
 *
 * These were lifted out of app.js, where metersBetween() delegated to
 * L.latLng().distanceTo(). That made the whole routing core untestable without
 * a browser and a map instance, for a function that is ultimately arithmetic.
 *
 * IMPORTANT: metersBetween must stay numerically identical to Leaflet's
 * L.CRS.Earth.distance(). Every routing threshold in this project
 * (JUNCTION_SNAP_METERS, CONNECT_THRESHOLD_METERS) was tuned by hand against
 * distances Leaflet produced, so a different earth model would silently
 * re-tune them and change which paths connect. The formula and the radius
 * below are Leaflet's, deliberately. tests/geo.test.js pins this against
 * values captured from Leaflet 1.9.4 itself.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CampusGeo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /** Leaflet's L.CRS.Earth.R — a sphere, not an ellipsoid. */
  const EARTH_RADIUS_METERS = 6371000;

  const DEG_TO_RAD = Math.PI / 180;

  /**
   * Great-circle distance in metres, matching L.CRS.Earth.distance() exactly.
   * Do not "improve" this to Vincenty/WGS84 without re-tuning the routing
   * thresholds — see the note at the top of this file.
   */
  function metersBetween(lat1, lng1, lat2, lng2) {
    const rad1 = lat1 * DEG_TO_RAD;
    const rad2 = lat2 * DEG_TO_RAD;
    const sinDLat = Math.sin(((lat2 - lat1) * DEG_TO_RAD) / 2);
    const sinDLng = Math.sin(((lng2 - lng1) * DEG_TO_RAD) / 2);

    const a = sinDLat * sinDLat + Math.cos(rad1) * Math.cos(rad2) * sinDLng * sinDLng;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return EARTH_RADIUS_METERS * c;
  }

  /**
   * Bounds-centre of a list of [lat, lng] points, matching
   * L.latLngBounds(points).getCenter() — the midpoint of the bounding box,
   * NOT the centroid of the polygon. app.js relies on the bounding-box
   * behaviour for marker placement, so keep it.
   */
  function boundsCenter(points) {
    if (!points || !points.length) return null;

    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;

    points.forEach(function (pt) {
      if (pt[0] < minLat) minLat = pt[0];
      if (pt[0] > maxLat) maxLat = pt[0];
      if (pt[1] < minLng) minLng = pt[1];
      if (pt[1] > maxLng) maxLng = pt[1];
    });

    return { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
  }

  /**
   * Inserts intermediate points roughly every 2m along a traced entry line, so
   * routing treats the whole line (or loop, e.g. a stadium track) as valid
   * ground to enter from rather than only its original vertices.
   */
  function densifyEntryLine(points, closed) {
    if (!points || points.length < 2) return points || [];

    const out = [];
    const segmentCount = closed ? points.length : points.length - 1;

    for (let i = 0; i < segmentCount; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      out.push(a);

      const steps = Math.max(1, Math.round(metersBetween(a[0], a[1], b[0], b[1]) / 2));
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }

    if (!closed) out.push(points[points.length - 1]);
    return out;
  }

  /** Initial bearing in degrees (0-360) from one point to another. */
  function bearingBetween(lat1, lng1, lat2, lng2) {
    const rad1 = lat1 * DEG_TO_RAD;
    const rad2 = lat2 * DEG_TO_RAD;
    const dLng = (lng2 - lng1) * DEG_TO_RAD;

    const y = Math.sin(dLng) * Math.cos(rad2);
    const x = Math.cos(rad1) * Math.sin(rad2) - Math.sin(rad1) * Math.cos(rad2) * Math.cos(dLng);

    return (Math.atan2(y, x) / DEG_TO_RAD + 360) % 360;
  }

  return {
    EARTH_RADIUS_METERS: EARTH_RADIUS_METERS,
    bearingBetween: bearingBetween,
    boundsCenter: boundsCenter,
    densifyEntryLine: densifyEntryLine,
    metersBetween: metersBetween,
  };
});
