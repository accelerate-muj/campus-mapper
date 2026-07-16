'use strict';

/**
 * Tests for src/geo.js.
 *
 * The metersBetween expectations are not hand-computed: they were captured from
 * Leaflet 1.9.4's own L.latLng().distanceTo() in a browser, then verified
 * bitwise-identical against this implementation across 20,000 random pairs.
 *
 * They exist to catch a well-meaning "upgrade" to a WGS84/Vincenty model. That
 * would be more accurate in the abstract and wrong here: JUNCTION_SNAP_METERS
 * and CONNECT_THRESHOLD_METERS were tuned against Leaflet's spherical numbers,
 * so changing the model silently re-tunes which paths connect.
 */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    factory(require('./harness.js'), require('../src/geo.js'));
  } else {
    factory(root.TestHarness, root.CampusGeo);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (harness, geo) {
  const describe = harness.describe;
  const it = harness.it;
  const assert = harness.assert;

  describe('geo.metersBetween', function () {
    it('matches Leaflet 1.9.4 on real campus coordinates', function () {
      assert.equal(geo.metersBetween(26.8465, 75.5619, 26.8465, 75.5659), 396.8411728533256);
      assert.equal(geo.metersBetween(26.8465, 75.5619, 26.842, 75.5686), 832.0053384755352);
    });

    it('matches Leaflet on a degree of longitude at the equator', function () {
      assert.equal(geo.metersBetween(0, 0, 0, 1), 111194.92664455874);
    });

    it('matches Leaflet near the pole', function () {
      assert.equal(geo.metersBetween(89.9, 0, 89.9, 180), 22238.985328911145);
    });

    it('matches Leaflet over a long intercontinental haul', function () {
      assert.equal(geo.metersBetween(-33.8688, 151.2093, 40.7128, -74.006), 15988755.50703963);
    });

    it('returns exactly zero for identical points', function () {
      assert.equal(geo.metersBetween(26.8443, 75.5653, 26.8443, 75.5653), 0);
    });

    it('is symmetric', function () {
      const ab = geo.metersBetween(26.8465, 75.5619, 26.842, 75.5686);
      const ba = geo.metersBetween(26.842, 75.5686, 26.8465, 75.5619);
      assert.equal(ab, ba);
    });

    it('uses a sphere of exactly Leaflet radius', function () {
      assert.equal(geo.EARTH_RADIUS_METERS, 6371000);
    });
  });

  describe('geo.boundsCenter', function () {
    it('returns the midpoint of the bounding box, not the polygon centroid', function () {
      // An L-shaped run of points: the bbox centre and the centroid differ, and
      // app.js depends on the bbox behaviour for marker placement.
      const center = geo.boundsCenter([
        [0, 0],
        [0, 10],
        [10, 10],
        [10, 0],
        [0, 0],
        [0, 0],
        [0, 0],
      ]);
      assert.deepEqual(center, { lat: 5, lng: 5 });
    });

    it('handles a single point', function () {
      assert.deepEqual(geo.boundsCenter([[26.8443, 75.5653]]), { lat: 26.8443, lng: 75.5653 });
    });

    it('returns null for empty input', function () {
      assert.equal(geo.boundsCenter([]), null);
      assert.equal(geo.boundsCenter(null), null);
    });
  });

  describe('geo.densifyEntryLine', function () {
    it('leaves a line of fewer than two points untouched', function () {
      assert.deepEqual(geo.densifyEntryLine([[1, 2]], false), [[1, 2]]);
      assert.deepEqual(geo.densifyEntryLine([], false), []);
      assert.deepEqual(geo.densifyEntryLine(null, false), []);
    });

    it('inserts points roughly every 2m along an open line', function () {
      const a = [26.8443, 75.5653];
      const b = [26.8443, 75.5663]; // ~99m east
      const out = geo.densifyEntryLine([a, b], false);

      assert.ok(out.length > 40, 'a ~99m line should densify to ~50 points, got ' + out.length);
      assert.deepEqual(out[0], a, 'starts at the first point');
      assert.deepEqual(out[out.length - 1], b, 'ends at the last point');

      // No gap should be much larger than the 2m target.
      let maxGap = 0;
      for (let i = 1; i < out.length; i++) {
        maxGap = Math.max(maxGap, geo.metersBetween(out[i - 1][0], out[i - 1][1], out[i][0], out[i][1]));
      }
      assert.ok(maxGap < 3, 'largest gap should stay near 2m, was ' + maxGap);
    });

    it('closes the loop when closed is true', function () {
      const square = [
        [26.8443, 75.5653],
        [26.8443, 75.5658],
        [26.8448, 75.5658],
        [26.8448, 75.5653],
      ];
      const open = geo.densifyEntryLine(square, false);
      const closed = geo.densifyEntryLine(square, true);

      assert.ok(closed.length > open.length, 'a closed loop densifies the extra closing segment');

      // The closing segment means the last point should lead back toward the first.
      const last = closed[closed.length - 1];
      const backToStart = geo.metersBetween(last[0], last[1], square[0][0], square[0][1]);
      assert.ok(backToStart < 3, 'closed loop should end adjacent to its start, was ' + backToStart + 'm');
    });
  });

  describe('geo.bearingBetween', function () {
    it('reports due east as 90 degrees', function () {
      const bearing = geo.bearingBetween(0, 0, 0, 1);
      assert.ok(Math.abs(bearing - 90) < 0.001, 'expected ~90, got ' + bearing);
    });

    it('reports due north as 0 degrees', function () {
      const bearing = geo.bearingBetween(0, 0, 1, 0);
      assert.ok(Math.abs(bearing) < 0.001, 'expected ~0, got ' + bearing);
    });

    it('always returns a value in [0, 360)', function () {
      const bearing = geo.bearingBetween(26.8443, 75.5653, 26.8400, 75.5600); // south-west
      assert.ok(bearing >= 0 && bearing < 360, 'got ' + bearing);
      assert.ok(bearing > 180 && bearing < 270, 'south-west should be in the third quadrant, got ' + bearing);
    });
  });
});
