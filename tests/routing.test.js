'use strict';

/**
 * Tests for src/routing.js.
 *
 * This covers the parts of the app that were hardest to trust and had no
 * coverage at all: junction snapping, component stitching, and the
 * bidirectional Dijkstra. The Dijkstra block includes a brute-force
 * Floyd-Warshall cross-check on random graphs — a hand-written expectation
 * would only prove the algorithm agrees with my reading of it, whereas an
 * independent shortest-path implementation actually tests it.
 */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    factory(require('./harness.js'), require('../src/routing.js'), require('../src/geo.js'));
  } else {
    factory(root.TestHarness, root.CampusRouting, root.CampusGeo);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (harness, routing, geo) {
  const describe = harness.describe;
  const it = harness.it;
  const assert = harness.assert;

  // Campus-scale anchor. At this latitude 0.0001 deg lat is ~11m, and
  // 0.0001 deg lng is ~9.9m — close enough that round numbers read naturally.
  const LAT = 26.8443;
  const LNG = 75.5653;

  /** Builds a path object offset from the anchor, in ~metre-ish steps. */
  function path(id, site, points) {
    return { id: id, site: site, points: points };
  }

  describe('routing.buildGraph', function () {
    it('turns one path into a chain of nodes and edges', function () {
      const graph = routing.buildGraph([path('p1', 'college', [[LAT, LNG], [LAT, LNG + 0.001], [LAT, LNG + 0.002]])], 'college');

      assert.equal(graph.nodes.length, 3);
      assert.equal(graph.adjacency[0].length, 1, 'an end node has one neighbour');
      assert.equal(graph.adjacency[1].length, 2, 'a middle node has two');
      assert.equal(graph.adjacency[2].length, 1);
    });

    it('ignores paths belonging to another site', function () {
      const graph = routing.buildGraph(
        [
          path('p1', 'college', [[LAT, LNG], [LAT, LNG + 0.001]]),
          path('p2', 'hostel', [[LAT + 0.01, LNG], [LAT + 0.01, LNG + 0.001]]),
        ],
        'college'
      );

      assert.equal(graph.nodes.length, 2, 'only the college path is in the graph');
    });

    it('merges waypoints from different paths into one junction when close', function () {
      // Second path starts ~1m from where the first ends: one real junction
      // that was digitised slightly apart.
      const graph = routing.buildGraph(
        [
          path('p1', 'college', [[LAT, LNG], [LAT, LNG + 0.001]]),
          path('p2', 'college', [[LAT + 0.00001, LNG + 0.001], [LAT + 0.001, LNG + 0.001]]),
        ],
        'college'
      );

      assert.equal(graph.nodes.length, 3, 'the shared junction is a single node, not two');
      const junction = graph.adjacency.filter(function (a) { return a.length === 2; });
      assert.equal(junction.length, 1, 'exactly one node joins both paths');
    });

    it('does not merge waypoints beyond the snap threshold', function () {
      // ~40m apart: well beyond JUNCTION_SNAP_METERS (12m).
      const graph = routing.buildGraph(
        [
          path('p1', 'college', [[LAT, LNG], [LAT, LNG + 0.001]]),
          path('p2', 'college', [[LAT + 0.0004, LNG + 0.001], [LAT + 0.001, LNG + 0.001]]),
        ],
        'college'
      );

      assert.equal(graph.nodes.length, 4, 'distinct waypoints stay distinct');
    });

    it('stitches disconnected fragments into one network and flags the bridge', function () {
      const graph = routing.buildGraph(
        [
          path('p1', 'college', [[LAT, LNG], [LAT, LNG + 0.001]]),
          path('p2', 'college', [[LAT + 0.005, LNG], [LAT + 0.005, LNG + 0.001]]), // ~550m away
        ],
        'college'
      );

      const bridged = [];
      graph.adjacency.forEach(function (edges, i) {
        edges.forEach(function (e) {
          if (e.bridged && i < e.to) bridged.push(e);
        });
      });

      assert.equal(bridged.length, 1, 'exactly one bridge joins the two fragments');
      assert.ok(bridged[0].dist > 400, 'the bridge spans the real gap');

      // And the whole thing is now reachable end to end.
      const route = routing.bidirectionalDijkstra(graph, 0, 3);
      assert.ok(route !== null, 'stitching makes the fragments mutually reachable');
      assert.ok(route.bridgedHops > 0, 'a route across the gap admits it used a bridge');
    });

    it('produces an empty graph for a site with no paths', function () {
      const graph = routing.buildGraph([], 'college');
      assert.deepEqual(graph, { nodes: [], adjacency: [] });
    });
  });

  describe('routing.bidirectionalDijkstra', function () {
    it('returns a zero-length route when start equals end', function () {
      const graph = routing.buildGraph([path('p1', 'college', [[LAT, LNG], [LAT, LNG + 0.001]])], 'college');
      const route = routing.bidirectionalDijkstra(graph, 0, 0);

      assert.deepEqual(route, { path: [0], dist: 0, bridgedHops: 0 });
    });

    it('finds the shortest of two competing routes', function () {
      // A diamond: a short northern hop vs a long southern detour.
      const graph = routing.buildGraph(
        [
          path('short', 'college', [[LAT, LNG], [LAT, LNG + 0.0005], [LAT, LNG + 0.001]]),
          path('long', 'college', [
            [LAT, LNG],
            [LAT - 0.002, LNG + 0.0005],
            [LAT, LNG + 0.001],
          ]),
        ],
        'college'
      );

      const start = 0;
      const end = graph.nodes.findIndex(function (n) { return Math.abs(n.lng - (LNG + 0.001)) < 1e-9 && Math.abs(n.lat - LAT) < 1e-9; });
      const route = routing.bidirectionalDijkstra(graph, start, end);

      const direct = geo.metersBetween(LAT, LNG, LAT, LNG + 0.001);
      assert.ok(route.dist < direct * 1.05, 'took the short way (' + route.dist + 'm vs ~' + direct + 'm direct)');
    });

    /**
     * Cross-checks the bidirectional search against Floyd-Warshall on random
     * graphs. This is the test that would actually catch a subtle bug in the
     * meeting-point/stopping rule.
     */
    it('agrees with a brute-force all-pairs shortest path on random graphs', function () {
      let seed = 42;
      function random() {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      }

      for (let trial = 0; trial < 25; trial++) {
        const count = 6 + Math.floor(random() * 6);
        const nodes = [];
        for (let i = 0; i < count; i++) {
          nodes.push({ lat: LAT + random() * 0.004, lng: LNG + random() * 0.004 });
        }

        const adjacency = nodes.map(function () { return []; });
        function connect(i, j) {
          if (i === j) return;
          if (adjacency[i].some(function (e) { return e.to === j; })) return;
          const d = geo.metersBetween(nodes[i].lat, nodes[i].lng, nodes[j].lat, nodes[j].lng);
          adjacency[i].push({ to: j, dist: d, bridged: false });
          adjacency[j].push({ to: i, dist: d, bridged: false });
        }

        // A spanning chain guarantees connectivity, plus random extra edges.
        for (let i = 1; i < count; i++) connect(i - 1, i);
        for (let k = 0; k < count; k++) connect(Math.floor(random() * count), Math.floor(random() * count));

        const graph = { nodes: nodes, adjacency: adjacency };

        // Floyd-Warshall reference.
        const best = [];
        for (let i = 0; i < count; i++) {
          best.push(new Array(count).fill(Infinity));
          best[i][i] = 0;
        }
        adjacency.forEach(function (edges, i) {
          edges.forEach(function (e) { best[i][e.to] = Math.min(best[i][e.to], e.dist); });
        });
        for (let k = 0; k < count; k++) {
          for (let i = 0; i < count; i++) {
            for (let j = 0; j < count; j++) {
              if (best[i][k] + best[k][j] < best[i][j]) best[i][j] = best[i][k] + best[k][j];
            }
          }
        }

        for (let i = 0; i < count; i++) {
          for (let j = 0; j < count; j++) {
            const route = routing.bidirectionalDijkstra(graph, i, j);
            assert.ok(route !== null, 'trial ' + trial + ': ' + i + '->' + j + ' should be reachable');
            assert.ok(
              Math.abs(route.dist - best[i][j]) < 1e-6,
              'trial ' + trial + ': ' + i + '->' + j + ' expected ' + best[i][j] + ' got ' + route.dist
            );
          }
        }
      }
    });

    it('returns a path whose consecutive nodes are genuinely adjacent', function () {
      const graph = routing.buildGraph(
        [path('p1', 'college', [[LAT, LNG], [LAT, LNG + 0.0005], [LAT, LNG + 0.001], [LAT + 0.0005, LNG + 0.001]])],
        'college'
      );
      const route = routing.bidirectionalDijkstra(graph, 0, 3);

      for (let i = 1; i < route.path.length; i++) {
        const from = route.path[i - 1];
        const to = route.path[i];
        const linked = graph.adjacency[from].some(function (e) { return e.to === to; });
        assert.ok(linked, 'node ' + from + ' -> ' + to + ' must be a real edge');
      }
    });
  });

  describe('routing.footprintCandidateNodes', function () {
    it('deduplicates by node, keeping the smallest snap distance', function () {
      const graph = routing.buildGraph([path('p1', 'college', [[LAT, LNG], [LAT, LNG + 0.001]])], 'college');

      // Two footprint points that both snap to node 0.
      const candidates = routing.footprintCandidateNodes(graph, [[LAT + 0.00005, LNG], [LAT + 0.0001, LNG]], 45);

      assert.equal(candidates.length, 1, 'one node, not one per footprint point');
      assert.ok(candidates[0].dist < 6, 'kept the closer of the two snap distances');
    });

    it('returns nothing when every point is beyond maxDist', function () {
      const graph = routing.buildGraph([path('p1', 'college', [[LAT, LNG], [LAT, LNG + 0.001]])], 'college');
      assert.deepEqual(routing.footprintCandidateNodes(graph, [[LAT + 0.05, LNG]], 45), []);
    });
  });

  describe('routing.bestEntryPointRoute', function () {
    it('reports unsnapped when a place is too far from the network', function () {
      const graph = routing.buildGraph([path('p1', 'college', [[LAT, LNG], [LAT, LNG + 0.001]])], 'college');
      const result = routing.bestEntryPointRoute(graph, [[LAT + 0.05, LNG]], [[LAT, LNG]], 45);

      assert.equal(result.ok, false);
      assert.equal(result.reason, 'unsnapped', 'this is what triggers the straight-line fallback');
    });

    it('routes between two footprints that both snap to the network', function () {
      const graph = routing.buildGraph(
        [path('p1', 'college', [[LAT, LNG], [LAT, LNG + 0.0005], [LAT, LNG + 0.001]])],
        'college'
      );
      const result = routing.bestEntryPointRoute(graph, [[LAT + 0.0001, LNG]], [[LAT + 0.0001, LNG + 0.001]], 45);

      assert.equal(result.ok, true);
      assert.ok(result.total > 0, 'total includes snap-in + walk + snap-out');
      assert.ok(result.total >= result.dist, 'total is never less than the network walk alone');
    });

    it('picks the entrance pairing with the lowest total, not the closest in isolation', function () {
      // A corridor. The "from" place has two entrances: one very close to the
      // network's west end, one slightly further but on the east end right
      // beside the destination. Snapping each end independently would choose
      // the west entrance and walk the whole corridor.
      const graph = routing.buildGraph(
        [path('p1', 'college', [[LAT, LNG], [LAT, LNG + 0.001], [LAT, LNG + 0.002]])],
        'college'
      );

      const fromFootprint = [
        [LAT + 0.00002, LNG],          // ~2m from the west end
        [LAT + 0.00008, LNG + 0.002],  // ~9m from the east end
      ];
      const toFootprint = [[LAT + 0.00002, LNG + 0.002]]; // beside the east end

      const result = routing.bestEntryPointRoute(graph, fromFootprint, toFootprint, 45);

      assert.equal(result.ok, true);
      assert.ok(
        result.total < 30,
        'should enter via the east entrance for a ~10m total, not walk the ~200m corridor (got ' + result.total + 'm)'
      );
      assert.equal(result.dist, 0, 'both ends snap to the same node, so no network walk is needed');
    });
  });
});
