'use strict';

/**
 * The walking-path routing engine: graph construction, bidirectional Dijkstra,
 * and entry-point pairing.
 *
 * Extracted verbatim from app.js. The behaviour is deliberately unchanged — the
 * thresholds below were hand-tuned against this campus's real data, so this
 * module is a move, not a rewrite. The only structural change is that paths are
 * passed in rather than read from a shared `siteData` closure, which is what
 * makes the engine testable without a map.
 *
 * Depends only on geo.js (pure arithmetic), so it runs in Node and the browser.
 */

(function (root, factory) {
  const geo = typeof module !== 'undefined' && module.exports ? require('./geo.js') : root.CampusGeo;
  const api = factory(geo);

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CampusRouting = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (geo) {
  const metersBetween = geo.metersBetween;

  /**
   * How close two waypoints from different paths must be to be one junction.
   * Raised from 12 to 20 upstream, alongside entry-point snapping: with entry
   * points now joining the graph, a tighter radius left too many real junctions
   * unmerged. Tuned against this campus's data — see the note in geo.js before
   * touching the distance model these numbers were tuned against.
   */
  const JUNCTION_SNAP_METERS = 20;

  /**
   * How far a place may be from the nearest graph node before routing gives up
   * on the network and falls back to a straight line. Generous because a
   * building's centroid can sit tens of metres from its own edge — see
   * footprintCandidateNodes, which snaps from footprint vertices, not centroids.
   */
  const CONNECT_THRESHOLD_METERS = 45;

  /**
   * Turns raw path polylines into a graph: every waypoint is a node, and
   * consecutive waypoints along one path are an edge. Waypoints from different
   * paths that land within JUNCTION_SNAP_METERS merge into one shared node —
   * a real junction that was digitised slightly apart — otherwise the paths
   * would be a pile of disconnected segments rather than a network.
   *
   * Places (buildings and landmarks) are then snapped in: each entry point
   * becomes a node joined to its nearest path node, so routing can reach a
   * place through its traced entrance rather than only at query time.
   *
   * Takes the whole `siteData` shape ({ paths, buildings, landmarks }) rather
   * than just paths, because entry snapping needs the places. Everything is
   * passed in rather than read from a closure — that is what keeps this
   * testable without a map.
   */
  function buildGraph(siteData, site) {
    // Tolerate being handed a bare paths array: older callers and several tests
    // predate entry snapping, and a graph of paths alone is still meaningful.
    const data = Array.isArray(siteData) ? { paths: siteData } : (siteData || {});
    const paths = data.paths || [];
    const buildings = data.buildings || [];
    const landmarks = data.landmarks || [];

    const nodes = [];
    const adjacency = [];

    function findOrCreateNode(lat, lng) {
      for (let i = 0; i < nodes.length; i++) {
        if (metersBetween(nodes[i].lat, nodes[i].lng, lat, lng) <= JUNCTION_SNAP_METERS) return i;
      }
      nodes.push({ lat: lat, lng: lng });
      adjacency.push([]);
      return nodes.length - 1;
    }

    function addEdge(i, j, dist, bridged) {
      if (i === j) return;
      if (!adjacency[i].some(function (e) { return e.to === j; })) {
        adjacency[i].push({ to: j, dist: dist, bridged: !!bridged });
        adjacency[j].push({ to: i, dist: dist, bridged: !!bridged });
      }
    }

    (paths || []).forEach(function (p) {
      if (p.site !== site) return;

      let prevIdx = null;
      p.points.forEach(function (pt) {
        const idx = findOrCreateNode(pt[0], pt[1]);
        if (prevIdx !== null && prevIdx !== idx) {
          addEdge(prevIdx, idx, metersBetween(nodes[prevIdx].lat, nodes[prevIdx].lng, nodes[idx].lat, nodes[idx].lng));
        }
        prevIdx = idx;
      });
    });

    /**
     * Snaps a place's entry points into the graph: each becomes a node joined
     * to its nearest path node, so routing can reach the place through its
     * traced entrance.
     *
     * Note the edge is only added when the nearest node is within
     * CONNECT_THRESHOLD_METERS. A place further away than that stays an
     * isolated node here, which is what preserves the straight-line fallback:
     * it never silently acquires an implausible connection.
     */
    function snapEntryToGraph(entry) {
      if (!entry || !entry.points || !entry.points.length) return;

      entry.points.forEach(function (pt) {
        const entryIdx = findOrCreateNode(pt[0], pt[1]);

        let bestNode = -1;
        let bestDist = Infinity;
        for (let i = 0; i < nodes.length; i++) {
          if (i === entryIdx) continue;
          const d = metersBetween(nodes[i].lat, nodes[i].lng, pt[0], pt[1]);
          if (d < bestDist) {
            bestDist = d;
            bestNode = i;
          }
        }

        if (bestNode >= 0 && bestDist <= CONNECT_THRESHOLD_METERS) addEdge(entryIdx, bestNode, bestDist);
      });
    }

    buildings.forEach(function (b) {
      if (b.site !== site) return;

      if (b.entry && b.entry.points && b.entry.points.length) {
        snapEntryToGraph(b.entry);
      } else {
        // No traced entrance: fall back to the footprint's average point so the
        // building is still reachable through the nearest path node.
        const pts = b.points || [];
        if (pts.length) {
          const cLat = pts.reduce(function (s, p) { return s + p[0]; }, 0) / pts.length;
          const cLng = pts.reduce(function (s, p) { return s + p[1]; }, 0) / pts.length;
          snapEntryToGraph({ points: [[cLat, cLng]] });
        }
      }
    });

    landmarks.forEach(function (l) {
      if (l.entry && l.entry.points && l.entry.points.length) snapEntryToGraph(l.entry);
      else snapEntryToGraph({ points: [[l.lat, l.lng]] });
    });

    function componentsOf() {
      const compId = new Array(nodes.length).fill(-1);
      let c = 0;

      for (let i = 0; i < nodes.length; i++) {
        if (compId[i] !== -1) continue;

        const stack = [i];
        compId[i] = c;
        while (stack.length) {
          const u = stack.pop();
          adjacency[u].forEach(function (e) {
            if (compId[e.to] === -1) {
              compId[e.to] = c;
              stack.push(e.to);
            }
          });
        }
        c++;
      }
      return { compId: compId, count: c };
    }

    // Each path is drawn as a separate stroke — a tracing convenience, not a
    // claim that they're unrelated. Repeatedly bridge the closest pair of nodes
    // from two different components until the site is one network. Bridged
    // edges are flagged so a route that uses one can say so honestly.
    let components = componentsOf();
    let guard = nodes.length; // hard cap so a data oddity can't infinite-loop

    while (components.count > 1 && guard-- > 0) {
      let best = null;

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          if (components.compId[i] === components.compId[j]) continue;
          const d = metersBetween(nodes[i].lat, nodes[i].lng, nodes[j].lat, nodes[j].lng);
          if (!best || d < best.d) best = { i: i, j: j, d: d };
        }
      }

      if (!best) break;
      addEdge(best.i, best.j, best.d, true);
      components = componentsOf();
    }

    return { nodes: nodes, adjacency: adjacency };
  }

  /** Nearest graph node to a lat/lng within maxDist metres, or null. */
  function nearestNode(graph, lat, lng, maxDist) {
    let best = null;
    let bestDist = Infinity;

    graph.nodes.forEach(function (n, i) {
      const d = metersBetween(n.lat, n.lng, lat, lng);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });

    if (best === null || bestDist > maxDist) return null;
    return { index: best, dist: bestDist };
  }

  /** As nearestNode, but snapping from whichever footprint vertex is closest. */
  function nearestNodeToFootprint(graph, footprint, maxDist) {
    let best = null;
    let bestDist = Infinity;
    let bestPoint = null;

    (footprint || []).forEach(function (pt) {
      graph.nodes.forEach(function (n, i) {
        const d = metersBetween(n.lat, n.lng, pt[0], pt[1]);
        if (d < bestDist) {
          bestDist = d;
          best = i;
          bestPoint = pt;
        }
      });
    });

    if (best === null || bestDist > maxDist) return null;
    return { index: best, dist: bestDist, point: bestPoint };
  }

  /**
   * Every distinct node reachable from a footprint, deduplicated by node index
   * keeping the smallest snap distance. Deliberately NOT collapsed to a single
   * closest point: the best entrance in isolation is not necessarily the one
   * that pairs best with the other end (see bestEntryPointRoute).
   */
  function footprintCandidateNodes(graph, footprint, maxDist) {
    const byNode = new Map();

    (footprint || []).forEach(function (pt) {
      graph.nodes.forEach(function (n, i) {
        const d = metersBetween(n.lat, n.lng, pt[0], pt[1]);
        if (d > maxDist) return;

        const existing = byNode.get(i);
        if (!existing || d < existing.dist) byNode.set(i, { index: i, dist: d, point: pt });
      });
    });

    return Array.from(byNode.values());
  }

  /**
   * Bidirectional Dijkstra: search outward from the start and backward from the
   * end at once, expanding whichever frontier is cheaper, until they meet. This
   * explores far less of the graph than a one-sided search and is still exact —
   * the stopping rule (frontierF + frontierB >= best meeting distance)
   * guarantees the shortest path rather than an approximation.
   */
  function bidirectionalDijkstra(graph, startIdx, endIdx) {
    const n = graph.nodes.length;
    if (startIdx === endIdx) return { path: [startIdx], dist: 0, bridgedHops: 0 };

    const distF = new Array(n).fill(Infinity);
    const prevF = new Array(n).fill(null);
    const bridgedF = new Array(n).fill(false);
    const visitedF = new Array(n).fill(false);

    const distB = new Array(n).fill(Infinity);
    const prevB = new Array(n).fill(null);
    const bridgedB = new Array(n).fill(false);
    const visitedB = new Array(n).fill(false);

    distF[startIdx] = 0;
    distB[endIdx] = 0;

    let mu = Infinity;
    let meetNode = -1;

    function pickNext(dist, visited) {
      let u = -1;
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        if (!visited[i] && dist[i] < best) {
          best = dist[i];
          u = i;
        }
      }
      return u;
    }

    for (let iter = 0; iter < n; iter++) {
      const uF = pickNext(distF, visitedF);
      const uB = pickNext(distB, visitedB);
      if (uF === -1 && uB === -1) break;

      const nextF = uF === -1 ? Infinity : distF[uF];
      const nextB = uB === -1 ? Infinity : distB[uB];
      if (nextF + nextB >= mu) break; // frontiers can't beat the best meeting point found

      if (nextF <= nextB && uF !== -1) {
        visitedF[uF] = true;
        if (visitedB[uF] && distF[uF] + distB[uF] < mu) {
          mu = distF[uF] + distB[uF];
          meetNode = uF;
        }
        graph.adjacency[uF].forEach(function (edge) {
          if (visitedF[edge.to]) return;
          const alt = distF[uF] + edge.dist;
          if (alt < distF[edge.to]) {
            distF[edge.to] = alt;
            prevF[edge.to] = uF;
            bridgedF[edge.to] = !!edge.bridged;
          }
          if (visitedB[edge.to] && alt + distB[edge.to] < mu) {
            mu = alt + distB[edge.to];
            meetNode = edge.to;
          }
        });
      } else if (uB !== -1) {
        visitedB[uB] = true;
        if (visitedF[uB] && distB[uB] + distF[uB] < mu) {
          mu = distB[uB] + distF[uB];
          meetNode = uB;
        }
        graph.adjacency[uB].forEach(function (edge) {
          if (visitedB[edge.to]) return;
          const alt = distB[uB] + edge.dist;
          if (alt < distB[edge.to]) {
            distB[edge.to] = alt;
            prevB[edge.to] = uB;
            bridgedB[edge.to] = !!edge.bridged;
          }
          if (visitedF[edge.to] && alt + distF[edge.to] < mu) {
            mu = alt + distF[edge.to];
            meetNode = edge.to;
          }
        });
      } else break;
    }

    if (meetNode === -1) return null;

    const path = [];
    let bridgedHops = 0;

    let cur = meetNode;
    while (cur !== null) {
      path.unshift(cur);
      if (bridgedF[cur]) bridgedHops++;
      cur = prevF[cur];
    }

    cur = meetNode;
    while (cur !== endIdx) {
      const next = prevB[cur];
      if (next === null) break;
      if (bridgedB[cur]) bridgedHops++;
      path.push(next);
      cur = next;
    }

    return { path: path, dist: mu, bridgedHops: bridgedHops };
  }

  /**
   * Routes between two places by trying every entrance pairing and keeping the
   * cheapest total (snap-in + network walk + snap-out).
   *
   * Snapping each end to its own single closest node independently can pick two
   * entrances that are far from EACH OTHER even though each looked optimal
   * alone — that is exactly how a route between two well-connected buildings
   * ends up taking an absurd detour. Footprints dedupe to a handful of nodes,
   * so the exhaustive O(candidates^2) pairing is cheap.
   */
  function bestEntryPointRoute(graph, fromFootprint, toFootprint, maxDist) {
    const startCandidates = footprintCandidateNodes(graph, fromFootprint, maxDist);
    const endCandidates = footprintCandidateNodes(graph, toFootprint, maxDist);

    if (!startCandidates.length || !endCandidates.length) return { ok: false, reason: 'unsnapped' };

    let best = null;

    startCandidates.forEach(function (s) {
      endCandidates.forEach(function (e) {
        if (s.index === e.index) {
          const total = s.dist + e.dist;
          if (!best || total < best.total) {
            best = { total: total, start: s, end: e, path: [s.index], dist: 0, bridgedHops: 0 };
          }
          return;
        }

        const result = bidirectionalDijkstra(graph, s.index, e.index);
        if (!result) return;

        const total = s.dist + result.dist + e.dist;
        if (!best || total < best.total) {
          best = { total: total, start: s, end: e, path: result.path, dist: result.dist, bridgedHops: result.bridgedHops };
        }
      });
    });

    if (!best) return { ok: false, reason: 'disconnected' };
    return Object.assign({ ok: true, reason: null }, best);
  }

  return {
    CONNECT_THRESHOLD_METERS: CONNECT_THRESHOLD_METERS,
    JUNCTION_SNAP_METERS: JUNCTION_SNAP_METERS,
    bestEntryPointRoute: bestEntryPointRoute,
    bidirectionalDijkstra: bidirectionalDijkstra,
    buildGraph: buildGraph,
    footprintCandidateNodes: footprintCandidateNodes,
    nearestNode: nearestNode,
    nearestNodeToFootprint: nearestNodeToFootprint,
  };
});
