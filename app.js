(function(){
  "use strict";

  // ---------- Map setup ----------
  const map = L.map('map', {
    minZoom: 2, maxZoom: 20, maxBoundsViscosity: 1.0, zoomControl: true,
    zoomSnap: 0.1, zoomDelta: 1,
    rotate: true, bearing: 0, touchRotate: false, shiftKeyRotate: false,
    rotateControl: { position: 'bottomleft', closeOnZeroBearing: false },
    // Default SVG renderer padding (0.1) only extends the drawing surface
    // 10% past the viewport on each side. That's fine for an unrotated map,
    // but leaflet-rotate spins the whole pane (tiles + overlays) with a CSS
    // transform — so at anything other than 0°, the renderer's own
    // axis-aligned rectangle no longer covers the rotated viewport's
    // corners, and its straight edge becomes visible as a hard line cutting
    // across the screen. A much bigger padding keeps that edge safely
    // outside the visible area at any rotation.
    renderer: L.svg({ padding: 1.5 })
  }).setView([20.5937, 78.9629], 5);

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 20,
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
  }).addTo(map);

  // Dedicated pane for the boundary mask: above the tile pane (200) so it
  // actually covers tiles, below the default overlay pane (400) so the
  // boundary outline, buildings, and landmarks still draw on top of it.
  map.createPane('maskPane');
  map.getPane('maskPane').style.zIndex = 350;
  map.getPane('maskPane').style.pointerEvents = 'none';

  // ---------- Persistent state ----------
  // BAKED_DATA is the committed, shared source of truth. It lives as plain
  // JSON in the <script id="mapData"> block right above this script — open
  // the file in a text editor and you'll see it as readable JSON, not
  // buried in code. To publish changes: click "Copy JSON", paste it over
  // the contents of that block, then commit/PR the file.
  const BAKED_DATA = window.BAKED_DATA;
  // Snapshot of exactly what's baked into the file right now. Used to
  // detect "the file on disk changed since I last saved a local draft" —
  // see loadData() below.
  const BAKED_SNAPSHOT = JSON.stringify(BAKED_DATA);

  const STORAGE_KEY = 'campusMapperData_v1';

  // ---------- Building categories ----------
  const CATEGORIES = [
    { id: 'academic',  label: 'Academic',        color: '#4fb3a9' },
    { id: 'hostel',    label: 'Hostel Block',    color: '#e08e45' },
    { id: 'dining',    label: 'Dining / Mess',   color: '#d9634f' },
    { id: 'sports',    label: 'Sports & Rec',    color: '#6aa9e0' },
    { id: 'admin',     label: 'Admin / Services',color: '#b98be0' },
    { id: 'other',     label: 'Other',           color: '#93a1ab' }
  ];
  const CATEGORY_BY_ID = {};
  CATEGORIES.forEach(c => CATEGORY_BY_ID[c.id] = c);
  function categoryOf(id){ return CATEGORY_BY_ID[id] || CATEGORY_BY_ID.other; }

  // Best-effort guess for buildings saved before categories existed, so
  // existing data (yours, or a collaborator's) isn't left uncategorized.
  function guessCategory(name){
    const n = (name || '').toLowerCase();
    if(/\bb[\s-]?\d/.test(n) || n.includes('hostel') || n.includes('common area')) return 'hostel';
    if(n.includes('academic') || n.includes('lecture') || n.includes('knowledge centre') || n.includes('cs lab')) return 'academic';
    if(n.includes('mess') || n.includes('canteen') || n.includes('amul')) return 'dining';
    if(n.includes('court') || n.includes('ground') || n.includes('stadium') || n.includes('park') || n.includes('gym')) return 'sports';
    if(n.includes('office') || n.includes('admin') || n.includes('atm') || n.includes('library') || n.includes('auditorium') || n.includes('desk') || n.includes('finance') || n.includes('stationary') || n.includes('laundry')) return 'admin';
    return 'other';
  }

  function defaultSite(){ return { boundary: null, locked: true, finalized: false }; }

  function cloneSite(s, legacyGlobalFinalized){
    let finalized;
    if(s && s.finalized !== undefined){
      finalized = !!s.finalized;
    } else if(legacyGlobalFinalized !== undefined){
      // Migrating an old save that only had one global `finalized` flag for
      // both sites. Only carry it over to a site that actually has a
      // boundary saved — a site with no boundary yet was never really
      // "finalized", whatever the old global flag said.
      finalized = !!legacyGlobalFinalized && !!(s && s.boundary);
    } else {
      finalized = false;
    }
    return {
      boundary: s && s.boundary ? s.boundary : null,
      locked: s && s.locked !== undefined ? s.locked : true,
      finalized: finalized
    };
  }

  // Buildings are now a single global list shared by both sites — each
  // building carries a `site` tag ("college" | "hostel") instead of living
  // nested inside siteData.college / siteData.hostel. This is what lets a
  // building drawn while on the Hostel tab still be found and clicked from
  // the College tab (and vice versa).
  // Entry points have gone through two shapes before this one:
  //   1. a single [lat, lng] pair (or null)
  //   2. a flat array of [lat, lng] pairs — multiple discrete entrances
  // They're now an object: { points, connected, closed }.
  //   - points: array of [lat, lng]
  //   - connected: false = each point is its own separate entrance (old
  //     behavior — routing approaches whichever one is nearest).
  //     true = the points are joined edge-to-edge into one continuous line,
  //     so routing can approach from ANY point along that line, not just
  //     the vertices — this is what "trace the whole track/fence" needs.
  //   - closed: only meaningful when connected — true means the line loops
  //     back from the last point to the first (a full ring, e.g. a circular
  //     track), false means it's an open line (e.g. one long fence edge).
  // This accepts all three shapes so previously-saved data doesn't break.
  function normalizeEntry(raw){
    if(!raw) return null;
    if(!Array.isArray(raw) && typeof raw === 'object'){
      const pts = (raw.points || [])
        .filter(p => Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'number')
        .map(p => [p[0], p[1]]);
      return pts.length ? { points: pts, connected: !!raw.connected, closed: !!raw.closed } : null;
    }
    if(!Array.isArray(raw) || raw.length === 0) return null;
    // Old single-pair format: [lat, lng]
    if(typeof raw[0] === 'number' && typeof raw[1] === 'number'){
      return { points: [[raw[0], raw[1]]], connected: false, closed: false };
    }
    // Old flat multi-point format: [[lat,lng], [lat,lng], ...]
    const pts = raw
      .filter(p => Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'number')
      .map(p => [p[0], p[1]]);
    return pts.length ? { points: pts, connected: false, closed: false } : null;
  }

  // Turns a connected entry line into a dense series of points spaced about
  // 2m apart, so routing's "nearest footprint point" check effectively
  // treats the whole line/loop as valid entry ground instead of just its
  // placed vertices (there's no separate point-to-segment distance check —
  // this is a deliberately simple way to get the same effect).
  function densifyEntryLine(points, closed){
    if(!points || points.length < 2) return points || [];
    const out = [];
    const segCount = closed ? points.length : points.length - 1;
    for(let i = 0; i < segCount; i++){
      const a = points[i];
      const b = points[(i + 1) % points.length];
      out.push(a);
      const distM = metersBetween(a[0], a[1], b[0], b[1]);
      const steps = Math.max(1, Math.round(distM / 2));
      for(let s = 1; s < steps; s++){
        const t = s / steps;
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    if(!closed) out.push(points[points.length - 1]);
    return out;
  }

  function cloneBuildings(list){
    return (list || []).map(b => ({
      id: b.id,
      name: b.name || null,
      site: (b.site === 'college' || b.site === 'hostel') ? b.site : 'college',
      landmarkId: b.landmarkId || null,
      category: CATEGORY_BY_ID[b.category] ? b.category : guessCategory(b.name),
      points: (b.points || []).map(p => [p[0], p[1]]),
      // Optional real-world door/gate location(s), placed by hand on the
      // map — one or more points. When set, routing approaches whichever of
      // these points is closest, instead of guessing from the footprint's
      // nearest vertex (see nearestNodeToFootprint).
      entry: normalizeEntry(b.entry),
      // Free-text floor label (e.g. "Ground Floor"), purely informational —
      // shown next to the name so places that share one footprint but sit
      // on different floors (like a library below an admin office) are
      // still distinguishable in the building list and Directions.
      floor: b.floor || null
    }));
  }

  // One-time migration for old saves (either an old local draft, or an old
  // mapData block) that still had buildings nested under college/hostel.
  function migrateBuildings(raw){
    if(Array.isArray(raw.buildings)) return cloneBuildings(raw.buildings);
    const merged = [];
    ['college','hostel'].forEach(site => {
      const nested = raw[site] && raw[site].buildings;
      if(Array.isArray(nested)){
        nested.forEach(b => merged.push(Object.assign({}, b, { site })));
      }
    });
    return cloneBuildings(merged);
  }

  function cloneLandmarks(list){
    return (list || []).map(l => ({
      id: l.id, name: l.name, lat: l.lat, lng: l.lng, resolved: !!l.resolved,
      entry: normalizeEntry(l.entry),
      floor: l.floor || null
    }));
  }

  // Walking paths: each is a named polyline (a sequence of lat/lng waypoints)
  // tagged with the site it belongs to. These are the raw edges of the
  // walking-path network that routing (see ROUTING GRAPH below) is built
  // from — this is static source data traced from the campus KML, not
  // something drawn in the UI yet.
  function clonePaths(list){
    return (list || []).map(p => ({
      id: p.id,
      name: p.name || null,
      site: (p.site === 'college' || p.site === 'hostel') ? p.site : 'college',
      points: (p.points || []).map(pt => [pt[0], pt[1]])
    }));
  }

  // Compass bearing is GLOBAL (not per-site) — once locked, it applies the
  // same fixed rotation to both College and Hostel, on every load.
  function cloneCompass(c){
    return {
      bearing: (c && typeof c.bearing === 'number') ? c.bearing : 0,
      locked: !!(c && c.locked)
    };
  }

  // Start from the committed BAKED_DATA (what's actually in the file/repo).
  let siteData = {
    college: cloneSite(BAKED_DATA.college, BAKED_DATA.finalized),
    hostel: cloneSite(BAKED_DATA.hostel, BAKED_DATA.finalized),
    buildings: migrateBuildings(BAKED_DATA),
    landmarks: cloneLandmarks(BAKED_DATA.landmarks),
    paths: clonePaths(BAKED_DATA.paths),
    compass: cloneCompass(BAKED_DATA.compass)
  };

  // localStorage is only a LOCAL DRAFT — it recovers work-in-progress if
  // you refresh the page before copying/publishing. It is never shared
  // with anyone; the mapData JSON block (and whatever you Copy) is the
  // only thing that actually gets shared.
  //
  // THE BUG THIS FIXES: previously, the draft always won on load, even if
  // you'd hand-edited the mapData block in the file itself. So editing the
  // file directly appeared to do nothing on reload — the stale browser
  // draft from an earlier session silently overrode it every time.
  //
  // Fix: each saved draft also stores a snapshot of what BAKED_DATA looked
  // like at the moment it was saved. On load, we only trust the draft if
  // that snapshot still matches the file's current mapData block — i.e.
  // nothing changed in the file since. If the file changed (you edited it,
  // pulled new buildings, redrew a boundary, etc.), the file wins and the
  // stale draft is discarded.
  function loadData(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) return;
      const parsed = JSON.parse(raw);
      if(parsed.__bakedSnapshot !== BAKED_SNAPSHOT){
        console.info('Campus Mapper: mapData file changed since last local draft — using file contents, discarding stale draft.');
        return;
      }
      ['college','hostel'].forEach(k=>{
        if(parsed[k]) siteData[k] = cloneSite(parsed[k], parsed.finalized);
      });
      siteData.buildings = migrateBuildings(parsed);
      if(parsed.landmarks) siteData.landmarks = cloneLandmarks(parsed.landmarks);
      if(parsed.paths) siteData.paths = clonePaths(parsed.paths);
      if(parsed.compass) siteData.compass = cloneCompass(parsed.compass);
    }catch(e){ console.warn('Could not load local draft', e); }
  }

  function saveData(){
    try{
      const toSave = Object.assign(currentDataForExport(), { __bakedSnapshot: BAKED_SNAPSHOT });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    }catch(e){ console.warn('Could not save local draft', e); }
  }

  loadData();

  // ---------- Copy current state as JSON ----------
  // Builds the exact object that belongs inside the <script id="mapData">
  // block, pretty-prints it, and copies it to the clipboard so you can
  // paste it directly over that block before committing.
  function currentDataForExport(){
    return {
      college: cloneSite(siteData.college),
      hostel: cloneSite(siteData.hostel),
      buildings: cloneBuildings(siteData.buildings),
      landmarks: cloneLandmarks(siteData.landmarks),
      paths: clonePaths(siteData.paths),
      compass: cloneCompass(siteData.compass)
    };
  }

  async function copyJSON(){
    const btn = document.getElementById('btnCopyJSON');
    const originalLabel = btn.textContent;
    const text = JSON.stringify(currentDataForExport(), null, 2);
    try{
      if(navigator.clipboard && navigator.clipboard.writeText){
        await navigator.clipboard.writeText(text);
      }else{
        throw new Error('no clipboard API');
      }
      btn.textContent = 'Copied ✓';
      setStatus('Copied JSON to clipboard — paste it over the contents of mapData.js, then commit/PR.');
    }catch(err){
      // Fallback: show it in a prompt box so it can be selected/copied manually.
      window.prompt('Copy this JS code and paste it over the entire contents of mapData.js:', 'window.BAKED_DATA = ' + text + ';');
      btn.textContent = originalLabel;
      setStatus('Clipboard access unavailable — the JSON was shown in a dialog for you to copy manually.');
      return;
    }
    setTimeout(()=>{ btn.textContent = originalLabel; }, 1800);
  }

  let currentSite = 'college';

  // ---------- Layer groups ----------
  const boundaryLayer = L.layerGroup().addTo(map);
  const buildingsLayer = L.layerGroup().addTo(map);
  const landmarksLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  const pathsLayer = L.layerGroup().addTo(map);
  const entryLayer = L.layerGroup().addTo(map);

  // ---------- Mobile panel collapse ----------
  const toolPanel = document.getElementById('toolPanel');
  const panelToggle = document.getElementById('panelToggle');
  const isSmallScreen = () => window.matchMedia('(max-width: 680px)').matches;

  panelToggle.addEventListener('click', function(){
    toolPanel.classList.toggle('collapsed');
    panelToggle.innerHTML = toolPanel.classList.contains('collapsed') ? '&#9650;' : '&#9660;';
  });
  if(isSmallScreen()) toolPanel.classList.add('collapsed');

  function expandPanelOnMobile(){
    if(isSmallScreen() && toolPanel.classList.contains('collapsed')){
      toolPanel.classList.remove('collapsed');
      panelToggle.innerHTML = '&#9660;';
    }
  }

  // ---------- Desktop sidebar hide/show ----------
  const sidebarHideBtn = document.getElementById('sidebarHideBtn');
  const sidebarShowBtn = document.getElementById('sidebarShowBtn');
  sidebarHideBtn.addEventListener('click', function(){
    toolPanel.classList.add('hidden-desktop');
    sidebarShowBtn.style.display = 'flex';
  });
  sidebarShowBtn.addEventListener('click', function(){
    toolPanel.classList.remove('hidden-desktop');
    sidebarShowBtn.style.display = 'none';
  });

  // ================= CONTRIBUTE (GitHub) =================
  // Adjust these three if the repo, branch, or file location ever changes —
  // everything else derives from them.
  const GITHUB_REPO = 'accelerate-muj/campus-mapper';
  const GITHUB_BRANCH = 'main';
  const GITHUB_FILE_PATH = 'mapData.js'; // the file that actually holds the map data

  const btnContribute = document.getElementById('btnContribute');
  const contributeMenu = document.getElementById('contributeMenu');
  const contribEditLink = document.getElementById('contribEditLink');
  const contribIssueLink = document.getElementById('contribIssueLink');
  const contribRepoLink = document.getElementById('contribRepoLink');

  contribEditLink.href = 'https://github.com/' + GITHUB_REPO + '/edit/' + GITHUB_BRANCH + '/' + GITHUB_FILE_PATH;
  contribIssueLink.href = 'https://github.com/' + GITHUB_REPO + '/issues/new?labels=map-data&body=' +
    encodeURIComponent('**Site:** College / Hostel (delete one)\n**Building or landmark:** \n**What\'s wrong / missing:** \n');
  contribRepoLink.href = 'https://github.com/' + GITHUB_REPO;

  function closeContributeMenu(){ contributeMenu.classList.remove('show'); }

  btnContribute.addEventListener('click', function(e){
    e.stopPropagation();
    contributeMenu.classList.toggle('show');
  });
  document.addEventListener('click', function(e){
    if(!e.target.closest('.contribute-widget')) closeContributeMenu();
  });
  // Any menu item that isn't a plain outbound link (those three GitHub
  // <a> tags) should close the dropdown once clicked, since clicking it
  // starts an editing mode on the map rather than navigating away.
  contributeMenu.querySelectorAll('button.menu-item').forEach(function(btn){
    btn.addEventListener('click', closeContributeMenu);
  });

  // ---------- Status helper ----------
  const statusBox = document.getElementById('statusBox');
  function setStatus(msg, active){
    statusBox.textContent = msg;
    statusBox.classList.toggle('active', !!active);
  }

  // ---------- UI refs ----------
  const tabCollege = document.getElementById('tabCollege');
  const tabHostel = document.getElementById('tabHostel');
  const buildingActions = document.getElementById('buildingActions');
  const btnBuildingUndo = document.getElementById('btnBuildingUndo');
  const btnBuildingFinish = document.getElementById('btnBuildingFinish');
  const btnBuildingCancel = document.getElementById('btnBuildingCancel');
  const buildingListEl = document.getElementById('buildingList');
  const buildingCountEl = document.getElementById('buildingCount');
  const emptyNote = document.getElementById('emptyNote');

  // Contribute-menu editing entry points — these replace the old always-
  // visible Setup tab. The side panel is now a pure view (Directions +
  // Buildings); every editing action is launched from here instead.
  const menuAddBuilding = document.getElementById('menuAddBuilding');
  const menuAddLandmark = document.getElementById('menuAddLandmark');
  const menuEditEntry = document.getElementById('menuEditEntry');
  const menuEditPaths = document.getElementById('menuEditPaths');
  const menuTraceLandmarks = document.getElementById('menuTraceLandmarks');
  const menuLandmarkBadge = document.getElementById('menuLandmarkBadge');
  const landmarksBox = document.getElementById('landmarksBox');
  const btnCloseLandmarks = document.getElementById('btnCloseLandmarks');
  const pathActions = document.getElementById('pathActions');
  const btnPathUndo = document.getElementById('btnPathUndo');
  const btnPathFinish = document.getElementById('btnPathFinish');
  const btnPathCancel = document.getElementById('btnPathCancel');
  const landmarkPlaceActions = document.getElementById('landmarkPlaceActions');
  const btnLandmarkPlaceCancel = document.getElementById('btnLandmarkPlaceCancel');

  // ================= BOUNDARY (finalized — drawing tools removed) =================
  // Both sites' boundaries are permanently set (see the "finalized" flag in
  // mapData above). Drawing/redrawing is intentionally no longer possible
  // from the UI; to change a boundary, edit the mapData JSON directly.
  const drawingBoundary = false; // kept so guard checks elsewhere stay valid no-ops

  // Boundary is stored as 4 real-world corner points (like a building),
  // so it can be a TRUE rectangle at whatever angle you rotated the map
  // to when you drew it — not just an axis-aligned north/south box.
  // Because it's stored in lat/lng, rotating the map afterward never
  // distorts it: the tiles and the rectangle rotate together as one
  // rigid picture, so it always reads as a proper rectangle.
  function cornersFromStored(stored){
    // Migrate old 2-point [SW, NE] format from before this change.
    if(stored.length === 2){
      const sw = stored[0], ne = stored[1];
      return [ [sw[0], sw[1]], [sw[0], ne[1]], [ne[0], ne[1]], [ne[0], sw[1]] ];
    }
    return stored;
  }
  function boundsFromCorners(corners){
    return L.latLngBounds(corners.map(c => L.latLng(c[0], c[1])));
  }

  // While actively dragging out the rectangle (or placing building
  // points), we pause rotation GESTURES so a stray two-finger twitch or
  // shift-drag doesn't spin the view mid-draw and throw off your corners.
  // We deliberately do NOT reset bearing to 0 — you rotate the map to
  // match your campus's angle first, then draw along that angle.
  let savedGestureState = null;
  function freezeRotationGesturesForDrawing(){
    savedGestureState = {
      touchWasEnabled: !!(map.touchRotate && map.touchRotate.enabled()),
      shiftWasEnabled: !!(map.shiftKeyRotate && map.shiftKeyRotate.enabled())
    };
    if(map.touchRotate) map.touchRotate.disable();
    if(map.shiftKeyRotate) map.shiftKeyRotate.disable();
  }
  function unfreezeRotationGesturesAfterDrawing(){
    if(!savedGestureState) return;
    // If the direction has been permanently locked, drawing's temporary
    // freeze should not resurrect rotation gestures afterward.
    if(siteData.compass && siteData.compass.locked){ savedGestureState = null; return; }
    if(savedGestureState.touchWasEnabled && map.touchRotate) map.touchRotate.enable();
    if(savedGestureState.shiftWasEnabled && map.shiftKeyRotate) map.shiftKeyRotate.enable();
    savedGestureState = null;
  }

  // ================= COMPASS / DIRECTION LOCK =================
  // A single global bearing, shared by both College and Hostel. Rotate the
  // map (drag the compass control, bottom-left) to whatever angle you want
  // first — then Finalize Direction freezes it there for good: every load,
  // every site switch, re-applies that exact bearing, and all rotation
  // gestures (touch, shift-drag, dragging the compass control itself) get
  // disabled so it can't drift out of sync between the two views.
  function applyCompassLock(){
    const locked = !!(siteData.compass && siteData.compass.locked);
    const rotateControlEl = document.querySelector('.leaflet-control-rotate');
    if(locked){
      map.setBearing(siteData.compass.bearing);
      if(map.touchRotate) map.touchRotate.disable();
      if(map.shiftKeyRotate) map.shiftKeyRotate.disable();
      if(map.compassBearing) map.compassBearing.disable();
      if(rotateControlEl) rotateControlEl.style.display = 'none';
    } else {
      if(rotateControlEl) rotateControlEl.style.display = '';
    }
  }

  function updateCompassUI(){
    const locked = !!(siteData.compass && siteData.compass.locked);
    const badge = document.getElementById('compassLockedBadge');
    if(badge){
      badge.style.display = locked ? 'inline-flex' : 'none';
      badge.textContent = 'Direction locked (' + Math.round(siteData.compass.bearing) + '°)';
    }
  }

  // No-op stub: boundary drawing can never be in progress anymore
  // (drawingBoundary is always false), but this is still called from a
  // few guard checks (site switching, building-draw start, etc.) so it
  // stays as a harmless no-op rather than touching every call site.
  function cancelBoundaryDraw(){}

  function applyBoundaryConstraint(bounds){
    // Note: Leaflet's maxBounds only understands axis-aligned (north/south)
    // boxes, so for a tilted boundary this pans/zoom-limits to its
    // north-aligned bounding box (a bit looser than the rectangle itself).
    // The rectangle you actually see drawn on the map stays the true,
    // tight, tilted shape — this only affects how far you can pan/zoom out.
    // The mask (below) is what actually hides the extra corners visually;
    // maxBounds here only stops you panning/zooming into them.
    //
    // Zoom level where the boundary fully COVERS the viewport (inside=true) —
    // not just where it's fully visible (that leaves empty space on whichever
    // axis doesn't match the screen's aspect ratio). This guarantees you can
    // never zoom/pan to see anything outside the drawn boundary's bounding box.
    map.setMaxBounds(null);
    map.setMinZoom(2);
    const coverZoom = map.getBoundsZoom(bounds, true);
    map.setMinZoom(coverZoom);
    map.setMaxBounds(bounds);
    map.setView(bounds.getCenter(), coverZoom);
    updateMask();
  }

  function releaseBoundaryConstraint(){
    map.setMaxBounds(null);
    map.setMinZoom(2);
    updateMask();
  }

  // ================= VISUAL MASK =================
  // maxBounds alone can only clip panning to an axis-aligned bounding box,
  // which is always bigger than a rotated boundary rectangle — that's why
  // tilted corners were showing through before. This draws an actual
  // opaque cutout: a ring around the boundary with the boundary punched
  // out as a hole, so only the rectangle you drew is ever visible.
  //
  // The outer ring is sized relative to the boundary itself (a generous
  // multiple of its span), NOT the whole world. Panning is already capped
  // to the boundary's bounding box by maxBounds, so the mask never needs
  // to cover more than that box plus a margin. A world-sized ring produced
  // an SVG path with enormous pixel coordinates once you zoomed in to
  // building level, which is what was causing the lag.
  const maskLayer = L.layerGroup().addTo(map);

  function updateMask(){
    maskLayer.clearLayers();
    const site = siteData[currentSite];
    if(!site.boundary || !site.locked) return;
    const corners = cornersFromStored(site.boundary).map(c => [c[0], c[1]]);
    const bounds = boundsFromCorners(corners);
    const latSpan = bounds.getNorth() - bounds.getSouth();
    const lngSpan = bounds.getEast() - bounds.getWest();
    const pad = Math.max(latSpan, lngSpan, 0.001) * 6;
    const outerRing = [
      [bounds.getSouth() - pad, bounds.getWest() - pad],
      [bounds.getSouth() - pad, bounds.getEast() + pad],
      [bounds.getNorth() + pad, bounds.getEast() + pad],
      [bounds.getNorth() + pad, bounds.getWest() - pad]
    ];
    // Exterior ring and hole ring must wind in opposite directions for the
    // hole to render as a hole (standard even-odd polygon-with-hole rule).
    const holeRing = corners.slice().reverse();
    L.polygon([outerRing, holeRing], {
      pane: 'maskPane',
      stroke: false,
      fillColor: '#0e1113',
      fillOpacity: 1,
      interactive: false
    }).addTo(maskLayer);
  }

  function renderBoundary(){
    boundaryLayer.clearLayers();
    const stored = siteData[currentSite].boundary;
    if(!stored) return;
    const corners = cornersFromStored(stored);
    L.polygon(corners, {
      color: '#e08e45', weight: 2, fillOpacity: 0.02, dashArray: '4,4'
    }).addTo(boundaryLayer);
  }

  function renderPaths(){
    pathsLayer.clearLayers();
    siteData.paths.forEach(function(p){
      if(p.site !== currentSite) return;
      const line = L.polyline(p.points, {
        color: '#93a1ab', weight: 2, opacity: 0.55, dashArray: '1,6', lineCap: 'round'
      }).bindTooltip(p.name || 'Path', { sticky: true }).addTo(pathsLayer);
      line.on('click', function(ev){
        if(!drawingPath) return; // only clickable-to-delete while Edit Paths mode is active
        L.DomEvent.stopPropagation(ev);
        deletePath(p.id);
      });
    });
  }

  // ================= BUILDING DRAWING (point-driven) =================
  let drawingBuilding = false;
  let currentPoints = [];
  let vertexMarkers = [];
  let previewLine = null;
  let pendingLandmarkId = null; // set when tracing was launched via a landmark's expand button

  const CLOSE_PIXEL_RADIUS = ('ontouchstart' in window) ? 18 : 12;
  const VERTEX_RADIUS = ('ontouchstart' in window) ? 7 : 5;

  function startBuildingDraw(){
    if(!siteData[currentSite].boundary){
      setStatus('Draw the site boundary first, then add buildings.');
      return;
    }
    if(drawingBoundary) cancelBoundaryDraw();
    drawingBuilding = true;
    currentPoints = [];
    clearTempVertexLayers();
    freezeRotationGesturesForDrawing();
    map.getContainer().classList.add('drawing-cursor');
    buildingActions.style.display = 'flex';
    setStatus('Click to place building corner points. Click the first point again (or hit Finish) to close it.', true);
  }

  // Launched from a landmark's ▸ expand button (map popup or panel list).
  // Centers on the point and starts the same trace flow, but remembers
  // which landmark this trace belongs to so Finish can auto-name it.
  function startBuildingDrawForLandmark(id){
    const lm = siteData.landmarks.find(l => l.id === id);
    if(!lm) return;
    map.setView([lm.lat, lm.lng], Math.max(map.getZoom(), 19));
    startBuildingDraw();
    if(drawingBuilding){
      pendingLandmarkId = id;
      setStatus('Tracing "' + lm.name + '". Click to place corner points around it, then Finish to name it automatically.', true);
    }
  }

  function clearTempVertexLayers(){
    vertexMarkers.forEach(m => map.removeLayer(m));
    vertexMarkers = [];
    if(previewLine){ map.removeLayer(previewLine); previewLine = null; }
  }

  function endBuildingDrawUI(){
    drawingBuilding = false;
    currentPoints = [];
    pendingLandmarkId = null;
    clearTempVertexLayers();
    map.getContainer().classList.remove('drawing-cursor');
    buildingActions.style.display = 'none';
    unfreezeRotationGesturesAfterDrawing();
  }

  function cancelBuildingDraw(){
    endBuildingDrawUI();
    setStatus('Building drawing cancelled.');
  }

  // ================= ENTRY POINTS (real door/gate, not centroid) =================
  // A building's centroid — or a landmark's single dropped pin — is rarely
  // where you actually walk in. A circular stadium's centroid is the middle
  // of the track; a library traced as a rectangle might have its only real
  // door on one specific side. Letting the user click the actual entrance
  // gives routing something honest to aim for, instead of snapping to
  // whichever footprint vertex happens to be geometrically nearest a path.
  let placingEntryFor = null; // { kind: 'building'|'landmark', id }
  // Two placement modes, toggled from the entryActions bar:
  //  - false (Separate points): each click is its own independent entrance.
  //    Click an existing pin to remove just that one.
  //  - true (Connect points): clicks are joined in order into one line, so
  //    the WHOLE line becomes valid entry ground (a track edge, a fence).
  //    Click back near the first point to close it into a loop (e.g. a full
  //    circular track) — that finishes placement automatically.
  let entryPlacementConnected = false;

  const entryActions = document.getElementById('entryActions');
  const btnEntryModeToggle = document.getElementById('btnEntryModeToggle');
  const btnEntryFinish = document.getElementById('btnEntryFinish');
  const btnEntryClearAll = document.getElementById('btnEntryClearAll');

  function updateEntryModeToggleUI(){
    btnEntryModeToggle.textContent = entryPlacementConnected ? 'Mode: Connect points (line/loop)' : 'Mode: Separate points';
    btnEntryModeToggle.classList.toggle('on', entryPlacementConnected);
  }

  function startEntryPlacement(kind, id){
    if(drawingBoundary) cancelBoundaryDraw();
    if(drawingBuilding) cancelBuildingDraw();
    placingEntryFor = { kind, id };
    // Resume in whatever mode this target's existing entry was placed in,
    // so re-opening a saved connected line doesn't silently switch modes.
    const target = findEntryTarget(kind, id);
    entryPlacementConnected = target && target.entry ? !!target.entry.connected : false;
    updateEntryModeToggleUI();
    entryActions.style.display = 'flex';
    map.getContainer().classList.add('drawing-cursor');
    setEntryPlacementStatus(target);
  }

  function setEntryPlacementStatus(target){
    if(entryPlacementConnected){
      setStatus('Click the map to trace a line along the entrance — click back near your first point to close it into a full loop (e.g. a circular track). Press Escape when done.', true);
    } else {
      setStatus('Click the map for each real entrance/gate this place has — add as many as you need. Click an existing pin to remove it. Press Escape when done.', true);
    }
  }

  function cancelEntryPlacement(){
    if(!placingEntryFor) return;
    placingEntryFor = null;
    entryActions.style.display = 'none';
    map.getContainer().classList.remove('drawing-cursor');
    setStatus('Done placing entry points.');
  }

  function findEntryTarget(kind, id){
    const list = kind === 'building' ? siteData.buildings : siteData.landmarks;
    return list.find(x => x.id === id) || null;
  }

  // Short label for entry buttons/tooltips, e.g. "2 entry points" /
  // "4-point entry line" / "5-point entry loop".
  function describeEntry(entry){
    if(!entry || !entry.points || !entry.points.length) return null;
    const n = entry.points.length;
    if(entry.connected) return n + '-point entry ' + (entry.closed ? 'loop' : 'line');
    return n + ' entry point' + (n === 1 ? '' : 's');
  }

  // Clicking within this radius of an already-placed entry point for the
  // SAME target removes that point instead of dropping a near-duplicate —
  // this is what lets one continuous click session both add points (click
  // empty ground) and remove them (click an existing pin) before you're done.
  const ENTRY_POINT_REMOVE_RADIUS_METERS = 6;

  // Same idea as isCloseToFirstPoint (used for closing a traced building),
  // but for closing a connected entry line back into a loop.
  function isCloseToFirstEntryPoint(latlng, pts){
    if(!pts || pts.length < 3) return false; // need a real shape before closing means anything
    const p1 = map.latLngToContainerPoint(latlng);
    const p2 = map.latLngToContainerPoint(L.latLng(pts[0][0], pts[0][1]));
    return p1.distanceTo(p2) <= CLOSE_PIXEL_RADIUS;
  }

  function placeEntryAt(latlng){
    if(!placingEntryFor) return;
    const target = findEntryTarget(placingEntryFor.kind, placingEntryFor.id);
    const kind = placingEntryFor.kind;
    if(!target){
      setStatus('That place no longer exists.');
      placingEntryFor = null;
      entryActions.style.display = 'none';
      map.getContainer().classList.remove('drawing-cursor');
      return;
    }
    const pts = (target.entry && target.entry.points) ? target.entry.points.slice() : [];
    let closed = target.entry ? !!target.entry.closed : false;
    let finished = false;

    if(entryPlacementConnected && isCloseToFirstEntryPoint(latlng, pts)){
      // Close the loop — the whole traced ring becomes the entry zone.
      closed = true;
      finished = true;
    } else {
      let removedIdx = -1;
      for(let i = 0; i < pts.length; i++){
        if(metersBetween(pts[i][0], pts[i][1], latlng.lat, latlng.lng) <= ENTRY_POINT_REMOVE_RADIUS_METERS){
          removedIdx = i;
          break;
        }
      }
      if(removedIdx !== -1){
        pts.splice(removedIdx, 1);
        if(pts.length < 3) closed = false;
      } else {
        pts.push([latlng.lat, latlng.lng]);
      }
    }

    target.entry = pts.length ? { points: pts, connected: entryPlacementConnected, closed: entryPlacementConnected && closed } : null;
    saveData();
    renderEntryMarkers();
    if(kind === 'building'){ renderBuildings(); } else { renderLandmarkList(); }
    populateDirectionSelects();

    if(finished){
      cancelEntryPlacement();
      setStatus('"' + (target.name || 'this place') + '" — loop closed, ' + pts.length + ' points along it now form the entry zone.');
      return;
    }
    const count = target.entry ? target.entry.points.length : 0;
    if(entryPlacementConnected){
      setStatus('"' + (target.name || 'this place') + '" — ' + count + ' point' + (count === 1 ? '' : 's') + ' on the line. ' +
        'Click back near the first point to close it into a loop, or press Escape when done as an open line.', true);
    } else {
      setStatus('"' + (target.name || 'this place') + '" — ' + count + ' entry point' + (count === 1 ? '' : 's') +
        '. Keep clicking to add more (or click a pin to remove it). Press Escape when done.', true);
    }
    // Deliberately stays in placement mode — placingEntryFor is NOT cleared
    // here — so a stadium track or a two-gate building can be traced with
    // several clicks in one go instead of re-opening placement each time.
  }

  function clearEntryPoint(kind, id){
    const target = findEntryTarget(kind, id);
    if(!target || !target.entry) return;
    target.entry = null;
    saveData();
    renderEntryMarkers();
    if(kind === 'building'){ renderBuildings(); } else { renderLandmarkList(); }
    populateDirectionSelects();
    setStatus('All entry points cleared for "' + (target.name || 'this place') + '".');
  }

  btnEntryModeToggle.addEventListener('click', function(){
    entryPlacementConnected = !entryPlacementConnected;
    updateEntryModeToggleUI();
    // Switching mode mid-session updates the target's existing entry (if
    // any) in place — the points themselves are kept either way.
    if(placingEntryFor){
      const target = findEntryTarget(placingEntryFor.kind, placingEntryFor.id);
      if(target && target.entry){
        target.entry.connected = entryPlacementConnected;
        if(!entryPlacementConnected) target.entry.closed = false;
        saveData();
        renderEntryMarkers();
      }
      setEntryPlacementStatus(target);
    }
  });
  btnEntryFinish.addEventListener('click', cancelEntryPlacement);
  btnEntryClearAll.addEventListener('click', function(){
    if(!placingEntryFor) return;
    clearEntryPoint(placingEntryFor.kind, placingEntryFor.id);
  });

  function renderEntryMarkers(){
    entryLayer.clearLayers();
    function drawEntry(place, label){
      const entry = place.entry;
      if(!entry || !entry.points || !entry.points.length) return;
      if(entry.connected && entry.points.length > 1){
        const linePts = entry.closed ? entry.points.concat([entry.points[0]]) : entry.points;
        L.polyline(linePts, { color: '#e0c145', weight: 4, opacity: 0.9 })
          .bindTooltip(label + ' — entry ' + (entry.closed ? 'loop' : 'line'), { sticky: true })
          .addTo(entryLayer);
        entry.points.forEach(function(pt){
          L.circleMarker([pt[0], pt[1]], {
            radius: 4, color: '#e0c145', fillColor: '#e0c145', fillOpacity: 1, weight: 1
          }).addTo(entryLayer);
        });
      } else {
        entry.points.forEach(function(pt, i){
          L.circleMarker([pt[0], pt[1]], {
            radius: 6, color: '#e0c145', fillColor: '#e0c145', fillOpacity: 1, weight: 2
          }).bindTooltip(label + ' — entry' + (entry.points.length > 1 ? ' #' + (i + 1) : ''), { sticky: true }).addTo(entryLayer);
        });
      }
    }
    siteData.buildings.filter(b => b.site === currentSite && b.entry).forEach(function(b){
      drawEntry(b, b.name || 'Building');
    });
    siteData.landmarks.filter(l => l.entry).forEach(function(l){
      drawEntry(l, l.name || 'Landmark');
    });
  }

  function promptFloorLabel(kind, id){
    const target = findEntryTarget(kind, id);
    if(!target) return;
    const next = window.prompt('Floor label for "' + (target.name || 'this place') + '" (e.g. "Ground Floor", "1st Floor"). Leave blank to clear:', target.floor || '');
    if(next === null) return; // cancelled
    target.floor = next.trim() || null;
    saveData();
    if(kind === 'building'){ renderBuildings(); } else { renderLandmarkList(); }
    populateDirectionSelects();
  }

  function updatePreview(){
    if(previewLine){ map.removeLayer(previewLine); previewLine = null; }
    if(currentPoints.length < 2) return;
    previewLine = L.polyline(currentPoints, { color: '#4fb3a9', weight: 2 }).addTo(map);
  }

  function isCloseToFirstPoint(latlng){
    if(currentPoints.length < 3) return false;
    const p1 = map.latLngToContainerPoint(latlng);
    const p2 = map.latLngToContainerPoint(currentPoints[0]);
    return p1.distanceTo(p2) <= CLOSE_PIXEL_RADIUS;
  }

  map.on('click', function(e){
    if(placingNewLandmark){ handleNewLandmarkClick(e.latlng); return; }
    if(placingEntryFor){ placeEntryAt(e.latlng); return; }
    if(drawingBoundary) return; // boundary uses drag, not click
    if(drawingPath){
      currentPathPoints.push(e.latlng);
      const marker = L.circleMarker(e.latlng, {
        radius: VERTEX_RADIUS, color: '#e0c145', fillColor: '#e0c145', fillOpacity: 1, weight: 2
      }).addTo(map);
      pathVertexMarkers.push(marker);
      updatePathPreview();
      return;
    }
    if(!drawingBuilding) return;

    if(isCloseToFirstPoint(e.latlng)){
      finishBuilding();
      return;
    }

    currentPoints.push(e.latlng);
    const marker = L.circleMarker(e.latlng, {
      radius: VERTEX_RADIUS, color: '#4fb3a9', fillColor: '#4fb3a9', fillOpacity: 1, weight: 2
    }).addTo(map);
    vertexMarkers.push(marker);
    updatePreview();
  });

  function undoLastPoint(){
    if(!drawingBuilding || currentPoints.length === 0) return;
    currentPoints.pop();
    const m = vertexMarkers.pop();
    if(m) map.removeLayer(m);
    updatePreview();
    setStatus(currentPoints.length + ' point(s) placed. Click to continue, or Finish to close.', true);
  }

  function finishBuilding(){
    if(currentPoints.length < 3){
      setStatus('Need at least 3 points to make a building. Add more points or cancel.', true);
      return;
    }

    let linkedLandmark = null;
    if(pendingLandmarkId){
      linkedLandmark = siteData.landmarks.find(l => l.id === pendingLandmarkId);
    }
    const capturedPoints = currentPoints.map(p => [p.lat, p.lng]);
    const capturedSite = currentSite;
    endBuildingDrawUI();

    openNameCategoryModal({
      defaultName: linkedLandmark ? linkedLandmark.name : '',
      defaultCategory: guessCategory(linkedLandmark ? linkedLandmark.name : ''),
      onSave: function(name, category){
        const building = {
          id: Date.now() + Math.random().toString(16).slice(2),
          name: name || null,
          site: capturedSite,
          landmarkId: linkedLandmark ? linkedLandmark.id : null,
          category: category,
          points: capturedPoints
        };
        siteData.buildings.push(building);
        if(linkedLandmark) linkedLandmark.resolved = true;
        saveData();
        renderBuildings();
        renderLandmarks();
        renderLandmarkList();
        populateCategoryFilter();
        populateDirectionSelects();
        setStatus(name ? ('"' + name + '" saved. Draw another, or switch tools.') : 'Building saved. Draw another, or switch tools.');
      },
      onCancel: function(){
        setStatus('Building discarded — the traced shape was not saved.');
      }
    });
  }

  // ================= NAME + CATEGORY MODAL =================
  const nameCategoryModal = document.getElementById('nameCategoryModal');
  const modalTitle = document.getElementById('modalTitle');
  const modalNameInput = document.getElementById('modalNameInput');
  const modalCategoryChips = document.getElementById('modalCategoryChips');
  const modalCancelBtn = document.getElementById('modalCancelBtn');
  const modalSaveBtn = document.getElementById('modalSaveBtn');
  let modalCallbacks = null;
  let modalSelectedCategory = 'other';

  function renderModalChips(){
    modalCategoryChips.innerHTML = '';
    CATEGORIES.forEach(function(cat){
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (cat.id === modalSelectedCategory ? ' selected' : '');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = cat.color;
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(cat.label));
      chip.addEventListener('click', function(){
        modalSelectedCategory = cat.id;
        renderModalChips();
      });
      modalCategoryChips.appendChild(chip);
    });
  }

  function openNameCategoryModal(opts){
    modalCallbacks = opts;
    modalTitle.textContent = opts.defaultName ? ('Confirm details for "' + opts.defaultName + '"') : 'Name this building';
    modalNameInput.value = opts.defaultName || '';
    modalSelectedCategory = opts.defaultCategory || 'other';
    renderModalChips();
    nameCategoryModal.style.display = 'flex';
    setTimeout(function(){ modalNameInput.focus(); }, 10);
  }

  function closeNameCategoryModal(){
    nameCategoryModal.style.display = 'none';
    modalCallbacks = null;
  }

  modalSaveBtn.addEventListener('click', function(){
    if(!modalCallbacks) return;
    const name = modalNameInput.value.trim();
    const category = modalSelectedCategory;
    const cb = modalCallbacks.onSave;
    closeNameCategoryModal();
    if(cb) cb(name, category);
  });
  modalCancelBtn.addEventListener('click', function(){
    if(!modalCallbacks) return;
    const cb = modalCallbacks.onCancel;
    closeNameCategoryModal();
    if(cb) cb();
  });
  modalNameInput.addEventListener('keydown', function(e){
    if(e.key === 'Enter'){ e.preventDefault(); modalSaveBtn.click(); }
  });

  btnBuildingCancel.addEventListener('click', cancelBuildingDraw);
  btnBuildingFinish.addEventListener('click', finishBuilding);
  btnBuildingUndo.addEventListener('click', undoLastPoint);
  document.getElementById('btnCopyJSON').addEventListener('click', copyJSON);

  // ================= EDIT MODE SWITCHING (Contribute menu) =================
  // Only one editing mode can be active at a time. Every mode-start function
  // calls this first so switching straight from, say, "Add Building" to
  // "Edit Paths" via the menu doesn't leave the old mode's map-click
  // listener or floating toolbar dangling.
  function cancelAllEditModes(){
    if(drawingBuilding) cancelBuildingDraw();
    if(placingEntryFor) cancelEntryPlacement();
    if(selectingEntryTarget) cancelSelectEntryTarget();
    if(drawingPath) cancelPathEdit();
    if(placingNewLandmark) cancelAddLandmark();
  }

  // ---------------- Add Landmark ----------------
  // A landmark is just a named pin waiting to be traced into a building
  // (see the LANDMARKS section below) — reusing that model means a
  // hand-placed landmark shows up in "Trace Landmarks" exactly like one
  // imported from the KML, with no separate code path needed.
  let placingNewLandmark = false;

  function startAddLandmark(){
    cancelAllEditModes();
    placingNewLandmark = true;
    map.getContainer().classList.add('drawing-cursor');
    landmarkPlaceActions.style.display = 'flex';
    setStatus('Click the map to drop a new landmark pin.', true);
  }

  function cancelAddLandmark(){
    placingNewLandmark = false;
    landmarkPlaceActions.style.display = 'none';
    map.getContainer().classList.remove('drawing-cursor');
  }

  function handleNewLandmarkClick(latlng){
    const name = (window.prompt('Name this landmark (e.g. "Block C2", "Volleyball Court"):', '') || '').trim();
    cancelAddLandmark();
    if(!name){ setStatus('Landmark discarded — no name given.'); return; }
    const lm = {
      id: 'lm_' + Date.now() + Math.random().toString(16).slice(2),
      name: name, lat: latlng.lat, lng: latlng.lng,
      resolved: false, entry: null, floor: null
    };
    siteData.landmarks.push(lm);
    saveData();
    renderLandmarks();
    renderLandmarkList();
    setStatus('Landmark "' + name + '" added — trace it into a building anytime from Contribute → Trace Landmarks.');
  }

  btnLandmarkPlaceCancel.addEventListener('click', function(){
    cancelAddLandmark();
    setStatus('Landmark placement cancelled.');
  });

  // ---------------- Add / Edit Entry Point (target picker) ----------------
  // The old per-item 📍 buttons lived in an always-visible Setup list.
  // Since the panel is view-only now, this mode instead waits for a click
  // on a building's polygon on the map (or a landmark in the Trace
  // Landmarks list, which still has its own 📍 button) and starts the
  // existing entry-placement flow for whatever was clicked.
  let selectingEntryTarget = false;

  function startSelectEntryTarget(){
    cancelAllEditModes();
    selectingEntryTarget = true;
    map.getContainer().classList.add('drawing-cursor');
    setStatus('Click a building on the map to set or edit its entrance. (Landmarks not yet traced into a building can get one from Contribute → Trace Landmarks.)', true);
  }

  function cancelSelectEntryTarget(){
    selectingEntryTarget = false;
    map.getContainer().classList.remove('drawing-cursor');
  }

  // ---------------- Edit Paths ----------------
  // Trace a new walking-path segment the same way a building is traced
  // (click to place waypoints, Finish to save) — except it stays an open
  // line, not a closed polygon, and only needs 2+ points. While this mode
  // is active, clicking an EXISTING path segment deletes it instead
  // (see renderPaths), so "edit" covers both adding and removing paths.
  let drawingPath = false;
  let currentPathPoints = [];
  let pathVertexMarkers = [];
  let pathPreviewLine = null;

  function startPathEdit(){
    cancelAllEditModes();
    drawingPath = true;
    currentPathPoints = [];
    clearTempPathVertexLayers();
    freezeRotationGesturesForDrawing();
    map.getContainer().classList.add('drawing-cursor');
    pathActions.style.display = 'flex';
    setStatus('Click to trace a new path (2+ points), then Finish. Click an existing dashed path to delete it instead.', true);
  }

  function clearTempPathVertexLayers(){
    pathVertexMarkers.forEach(m => map.removeLayer(m));
    pathVertexMarkers = [];
    if(pathPreviewLine){ map.removeLayer(pathPreviewLine); pathPreviewLine = null; }
  }

  function endPathEditUI(){
    drawingPath = false;
    currentPathPoints = [];
    clearTempPathVertexLayers();
    map.getContainer().classList.remove('drawing-cursor');
    pathActions.style.display = 'none';
    unfreezeRotationGesturesAfterDrawing();
  }

  function cancelPathEdit(){
    endPathEditUI();
    setStatus('Path editing closed.');
  }

  function updatePathPreview(){
    if(pathPreviewLine){ map.removeLayer(pathPreviewLine); pathPreviewLine = null; }
    if(currentPathPoints.length < 2) return;
    pathPreviewLine = L.polyline(currentPathPoints, { color: '#e0c145', weight: 2, dashArray: '4,4' }).addTo(map);
  }

  function undoLastPathPoint(){
    if(!drawingPath || currentPathPoints.length === 0) return;
    currentPathPoints.pop();
    const m = pathVertexMarkers.pop();
    if(m) map.removeLayer(m);
    updatePathPreview();
    setStatus(currentPathPoints.length + ' point(s) placed for the new path.', true);
  }

  function finishPath(){
    if(currentPathPoints.length < 2){
      setStatus('Need at least 2 points to make a path segment. Add more, or Cancel.', true);
      return;
    }
    const name = (window.prompt('Name this path segment (optional):', '') || '').trim();
    const path = {
      id: 'path_' + Date.now() + Math.random().toString(16).slice(2),
      name: name || null,
      site: currentSite,
      points: currentPathPoints.map(p => [p.lat, p.lng])
    };
    siteData.paths.push(path);
    saveData();
    endPathEditUI();
    renderPaths();
    graphCache = {}; // the routing graph is built lazily from siteData.paths — drop the stale cache
    populateDirectionSelects();
    setStatus('Path segment saved. Trace another from Contribute → Edit Paths, or switch tools.');
  }

  function deletePath(pathId){
    const p = siteData.paths.find(pp => pp.id === pathId);
    if(!p) return;
    if(!window.confirm('Delete ' + (p.name || 'this path segment') + '?')) return;
    siteData.paths = siteData.paths.filter(pp => pp.id !== pathId);
    saveData();
    renderPaths();
    graphCache = {};
    populateDirectionSelects();
    setStatus('Path segment deleted.');
  }

  btnPathCancel.addEventListener('click', cancelPathEdit);
  btnPathFinish.addEventListener('click', finishPath);
  btnPathUndo.addEventListener('click', undoLastPathPoint);

  // ---------------- Contribute menu → mode wiring ----------------
  menuAddBuilding.addEventListener('click', startBuildingDraw);
  menuAddLandmark.addEventListener('click', startAddLandmark);
  menuEditEntry.addEventListener('click', startSelectEntryTarget);
  menuEditPaths.addEventListener('click', startPathEdit);
  menuTraceLandmarks.addEventListener('click', function(){
    cancelAllEditModes();
    landmarksBox.style.display = 'block';
    expandPanelOnMobile();
    landmarksBox.scrollIntoView({ block: 'nearest' });
  });
  btnCloseLandmarks.addEventListener('click', function(){
    landmarksBox.style.display = 'none';
  });

  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape'){
      if(nameCategoryModal.style.display === 'flex'){ modalCancelBtn.click(); return; }
      if(placingNewLandmark){ cancelAddLandmark(); setStatus('Landmark placement cancelled.'); return; }
      if(selectingEntryTarget){ cancelSelectEntryTarget(); setStatus('Entry point editing cancelled.'); return; }
      if(placingEntryFor) cancelEntryPlacement();
      if(drawingPath) cancelPathEdit();
      if(drawingBuilding) cancelBuildingDraw();
      if(drawingBoundary) cancelBoundaryDraw();
    }
    if(e.key === 'Enter' && drawingBuilding){
      finishBuilding();
    }
    if(e.key === 'Enter' && drawingPath){
      finishPath();
    }
  });

  // ================= LANDMARKS (imported points to trace) =================
  // Rendered as small markers on the map; each has an expand (▸) button —
  // in its map popup and in the panel list — that starts a building trace
  // pre-linked to it. Finishing that trace auto-names the building and
  // marks the landmark resolved, removing it from the pending list.
  function renderLandmarks(){
    landmarksLayer.clearLayers();
    siteData.landmarks.forEach(function(lm){
      if(lm.resolved) return;
      const marker = L.circleMarker([lm.lat, lm.lng], {
        radius: 6, color: '#4fb3a9', fillColor: '#1b2127', fillOpacity: 0.9, weight: 2
      }).addTo(landmarksLayer);

      const popupEl = document.createElement('div');
      popupEl.style.cssText = 'font-size:13px; color:#14181c; min-width:150px;';
      const label = document.createElement('div');
      label.textContent = lm.name;
      label.style.cssText = 'font-weight:700; margin-bottom:6px;';
      const btn = document.createElement('button');
      btn.textContent = '▸ Mark building';
      btn.style.cssText = 'appearance:none; border:1px solid #313b44; background:#4fb3a9; color:#0d1414; font-weight:700; font-size:12px; padding:6px 10px; border-radius:6px; cursor:pointer;';
      btn.addEventListener('click', function(){ startBuildingDrawForLandmark(lm.id); marker.closePopup(); });
      popupEl.appendChild(label);
      popupEl.appendChild(btn);
      marker.bindPopup(popupEl);
    });
  }

  function renderLandmarkList(){
    const listEl = document.getElementById('landmarkList');
    const countEl = document.getElementById('landmarkCount');
    const emptyEl = document.getElementById('landmarkEmptyNote');
    listEl.innerHTML = '';

    const pending = siteData.landmarks.filter(l => !l.resolved);
    countEl.textContent = pending.length ? '(' + pending.length + ')' : '';
    emptyEl.style.display = pending.length ? 'none' : 'block';
    menuLandmarkBadge.textContent = pending.length ? String(pending.length) : '';

    pending.forEach(function(lm){
      const li = document.createElement('li');
      const nameSpan = document.createElement('span');
      nameSpan.className = 'lm-name';
      nameSpan.textContent = lm.name + (lm.floor ? ' (' + lm.floor + ')' : '');
      nameSpan.title = lm.name;

      const floorBtn = document.createElement('button');
      floorBtn.className = 'expand-btn';
      floorBtn.textContent = '🏢';
      floorBtn.title = lm.floor ? ('Floor: ' + lm.floor + ' — click to edit') : 'Set floor label';
      floorBtn.addEventListener('click', function(ev){
        ev.stopPropagation();
        promptFloorLabel('landmark', lm.id);
      });

      const lmEntryCount = lm.entry ? lm.entry.points.length : 0;
      const entryBtn = document.createElement('button');
      entryBtn.className = 'expand-btn' + (lmEntryCount ? ' has-entry' : '');
      entryBtn.textContent = '📍';
      entryBtn.title = lmEntryCount
        ? describeEntry(lm.entry) + ' set — click to add/remove, shift-click to clear all'
        : 'Click the map to set this place\'s real entrance (click multiple times for multiple entries)';
      entryBtn.addEventListener('click', function(ev){
        ev.stopPropagation();
        if(ev.shiftKey && lmEntryCount){ clearEntryPoint('landmark', lm.id); return; }
        startEntryPlacement('landmark', lm.id);
      });

      const btn = document.createElement('button');
      btn.className = 'expand-btn';
      btn.textContent = '▸';
      btn.title = 'Mark this building';
      btn.addEventListener('click', function(ev){
        ev.stopPropagation();
        startBuildingDrawForLandmark(lm.id);
      });
      li.appendChild(nameSpan);
      const controls = document.createElement('span');
      controls.style.display = 'flex';
      controls.style.alignItems = 'center';
      controls.style.gap = '4px';
      controls.style.flex = 'none';
      controls.appendChild(floorBtn);
      controls.appendChild(entryBtn);
      controls.appendChild(btn);
      li.appendChild(controls);
      li.addEventListener('click', function(){
        map.setView([lm.lat, lm.lng], Math.max(map.getZoom(), 18));
      });
      listEl.appendChild(li);
    });
    renderEntryMarkers();
  }

  // ================= RENDER BUILDINGS + LIST =================
  const buildingPolygons = {}; // id -> layer
  const categoryFilterEl = document.getElementById('categoryFilter');
  const categoryLegendEl = document.getElementById('categoryLegend');
  let activeCategoryFilter = 'all';

  function goToBuilding(b, poly){
    const bounds = poly ? poly.getBounds() : L.latLngBounds(b.points.map(p => L.latLng(p[0], p[1])));
    map.fitBounds(bounds, { maxZoom: map.getMaxZoom() });
  }

  // Buildings belonging to the OTHER site are never rendered here — this
  // is what actually keeps the view strictly inside the current site's
  // boundary. (Previously the other site's buildings were drawn dimmed on
  // top of the mask, which is what let College bleed through while
  // viewing Hostel, even though the mask itself was painted correctly.)
  function currentSiteBuildings(){
    return siteData.buildings.filter(b => b.site === currentSite);
  }

  function populateCategoryFilter(){
    const present = new Set(currentSiteBuildings().map(b => b.category || 'other'));
    const prev = activeCategoryFilter;
    categoryFilterEl.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = 'all'; allOpt.textContent = 'All categories';
    categoryFilterEl.appendChild(allOpt);
    CATEGORIES.forEach(function(cat){
      if(!present.has(cat.id)) return;
      const opt = document.createElement('option');
      opt.value = cat.id; opt.textContent = cat.label;
      categoryFilterEl.appendChild(opt);
    });
    activeCategoryFilter = (prev === 'all' || present.has(prev)) ? prev : 'all';
    categoryFilterEl.value = activeCategoryFilter;
  }

  function renderCategoryLegend(list){
    categoryLegendEl.innerHTML = '';
    const present = new Set(list.map(b => b.category || 'other'));
    CATEGORIES.forEach(function(cat){
      if(!present.has(cat.id)) return;
      const tag = document.createElement('span');
      tag.className = 'tag';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = cat.color;
      tag.appendChild(dot);
      tag.appendChild(document.createTextNode(cat.label));
      categoryLegendEl.appendChild(tag);
    });
  }

  function renderBuildings(){
    buildingsLayer.clearLayers();
    buildingListEl.innerHTML = '';

    const all = currentSiteBuildings();
    const list = activeCategoryFilter === 'all' ? all : all.filter(b => (b.category || 'other') === activeCategoryFilter);

    list.forEach(function(b, idx){
      const latlngs = b.points.map(p => L.latLng(p[0], p[1]));
      const cat = categoryOf(b.category);
      const poly = L.polygon(latlngs, {
        color: cat.color, weight: 2, fillColor: cat.color, fillOpacity: 0.28
      }).addTo(buildingsLayer);
      const displayName = b.name || ('Building ' + (idx + 1));
      poly.bindTooltip(displayName + ' · ' + cat.label, { sticky: true });
      poly.on('click', function(){
        if(selectingEntryTarget){
          cancelSelectEntryTarget();
          startEntryPlacement('building', b.id);
          return;
        }
        goToBuilding(b, poly);
      });
    });

    buildingCountEl.textContent = list.length ? '(' + list.length + ')' : '';
    emptyNote.style.display = list.length ? 'none' : 'block';
    renderCategoryLegend(all);

    list.forEach(function(b, idx){
      const baseName = b.name || ('Building ' + (idx + 1));
      const displayName = baseName + (b.floor ? ' (' + b.floor + ')' : '');
      const cat = categoryOf(b.category);
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.style.display = 'flex';
      label.style.alignItems = 'center';
      label.style.overflow = 'hidden';
      const dot = document.createElement('span');
      dot.className = 'building-cat-dot';
      dot.style.background = cat.color;
      label.appendChild(dot);
      const nameSpan = document.createElement('span');
      nameSpan.textContent = displayName;
      nameSpan.style.overflow = 'hidden';
      nameSpan.style.textOverflow = 'ellipsis';
      nameSpan.style.whiteSpace = 'nowrap';
      label.appendChild(nameSpan);

      const floorBtn = document.createElement('button');
      floorBtn.className = 'expand-btn';
      floorBtn.textContent = '🏢';
      floorBtn.title = b.floor ? ('Floor: ' + b.floor + ' — click to edit') : 'Set floor label';
      floorBtn.addEventListener('click', function(ev){
        ev.stopPropagation();
        promptFloorLabel('building', b.id);
      });

      const bEntryCount = b.entry ? b.entry.points.length : 0;
      const entryBtn = document.createElement('button');
      entryBtn.className = 'expand-btn' + (bEntryCount ? ' has-entry' : '');
      entryBtn.textContent = '📍';
      entryBtn.title = bEntryCount
        ? describeEntry(b.entry) + ' set — click to add/remove, shift-click to clear all'
        : 'Click the map to set this building\'s real entrance (click multiple times for multiple entries)';
      entryBtn.addEventListener('click', function(ev){
        ev.stopPropagation();
        if(ev.shiftKey && bEntryCount){ clearEntryPoint('building', b.id); return; }
        startEntryPlacement('building', b.id);
      });

      const x = document.createElement('span');
      x.textContent = '✕';
      x.className = 'x';
      x.title = 'Delete this building';
      x.addEventListener('click', function(ev){
        ev.stopPropagation();
        siteData.buildings = siteData.buildings.filter(bb => bb.id !== b.id);
        if(b.landmarkId){
          const lm = siteData.landmarks.find(l => l.id === b.landmarkId);
          if(lm){ lm.resolved = false; renderLandmarks(); renderLandmarkList(); }
        }
        saveData();
        populateCategoryFilter();
        renderBuildings();
        populateDirectionSelects();
      });
      li.appendChild(label);
      const controls = document.createElement('span');
      controls.style.display = 'flex';
      controls.style.alignItems = 'center';
      controls.style.gap = '4px';
      controls.style.flex = 'none';
      controls.appendChild(floorBtn);
      controls.appendChild(entryBtn);
      controls.appendChild(x);
      li.appendChild(controls);
      li.addEventListener('click', function(){
        const latlngs = b.points.map(p => L.latLng(p[0], p[1]));
        map.fitBounds(L.latLngBounds(latlngs), { maxZoom: map.getMaxZoom() });
      });
      buildingListEl.appendChild(li);
    });
    renderEntryMarkers();
  }

  categoryFilterEl.addEventListener('change', function(){
    activeCategoryFilter = categoryFilterEl.value;
    renderBuildings();
  });

  // ================= DIRECTIONS (straight-line, within current site) =================
  // There's no traced walking-path network for the whole campus, so this
  // draws an honest straight-line ("as the crow flies") route between two
  // named places with distance + compass heading — not a turn-by-turn walking
  // route. Scoped to the currently active site, since College and Hostel are
  // separately masked/locked views.
  const dirFromEl = document.getElementById('dirFrom');
  const dirToEl = document.getElementById('dirTo');
  const routeReadoutEl = document.getElementById('routeReadout');
  const btnShowRoute = document.getElementById('btnShowRoute');
  const btnClearRoute = document.getElementById('btnClearRoute');

  function pointInPolygon(lat, lng, corners){
    let inside = false;
    for(let i = 0, j = corners.length - 1; i < corners.length; j = i++){
      const xi = corners[i][1], yi = corners[i][0];
      const xj = corners[j][1], yj = corners[j][0];
      const intersect = ((yi > lat) !== (yj > lat)) &&
        (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
      if(intersect) inside = !inside;
    }
    return inside;
  }

  // ================= ROUTING GRAPH (Dijkstra) =================
  // Turns the raw walking-path polylines (siteData.paths) into a proper
  // graph: every waypoint becomes a node, consecutive waypoints along one
  // path become an edge. Waypoints from different paths that land close
  // together — a real junction that was just digitized slightly apart —
  // get merged into a single shared node, or the paths would only ever be
  // a pile of disconnected segments instead of a network.
  //
  // Two distance thresholds matter here:
  //  - JUNCTION_SNAP_METERS: how close two waypoints from different paths
  //    need to be to count as "the same junction".
  //  - CONNECT_THRESHOLD_METERS: how far a building/landmark is allowed to
  //    be from the nearest graph node before routing gives up on the path
  //    network entirely and falls back to a straight line.
  const JUNCTION_SNAP_METERS = 12;
  // A building's centroid can be tens of meters from its own edge (a
  // stadium or sports ground especially), so this threshold has to be
  // generous enough to cover "the nearest point on the building is near a
  // path" rather than "the building's center is near a path". Tuned
  // against this campus's actual data — see nearestNodeToFootprint below,
  // which snaps from the closest footprint vertex, not the centroid.
  const CONNECT_THRESHOLD_METERS = 45;

  let graphCache = {}; // site -> { nodes:[{lat,lng}], adjacency:[[{to,dist}]] }

  function metersBetween(lat1, lng1, lat2, lng2){
    return L.latLng(lat1, lng1).distanceTo(L.latLng(lat2, lng2));
  }

  function buildGraphForSite(site){
    const nodes = [];
    const adjacency = [];

    function findOrCreateNode(lat, lng){
      for(let i = 0; i < nodes.length; i++){
        if(metersBetween(nodes[i].lat, nodes[i].lng, lat, lng) <= JUNCTION_SNAP_METERS){
          return i;
        }
      }
      nodes.push({ lat, lng });
      adjacency.push([]);
      return nodes.length - 1;
    }

    function addEdge(i, j, dist, bridged){
      if(i === j) return;
      if(!adjacency[i].some(e => e.to === j)){
        adjacency[i].push({ to: j, dist, bridged: !!bridged });
        adjacency[j].push({ to: i, dist, bridged: !!bridged });
      }
    }

    siteData.paths.forEach(function(p){
      if(p.site !== site) return;
      let prevIdx = null;
      p.points.forEach(function(pt){
        const idx = findOrCreateNode(pt[0], pt[1]);
        if(prevIdx !== null && prevIdx !== idx){
          const dist = metersBetween(
            nodes[prevIdx].lat, nodes[prevIdx].lng, nodes[idx].lat, nodes[idx].lng
          );
          addEdge(prevIdx, idx, dist);
        }
        prevIdx = idx;
      });
    });

    // You draw each path as a separate stroke — that's a tracing
    // convenience, not a statement that they're unrelated. Stitch every
    // disconnected fragment into one network per site: repeatedly find the
    // closest pair of nodes belonging to two different clusters and bridge
    // them, same idea as building a minimum-spanning connection between
    // "islands", until the whole site is one graph. Bridged edges are
    // flagged so a route that uses one can say so honestly.
    function componentsOf(){
      const compId = new Array(nodes.length).fill(-1);
      let c = 0;
      for(let i = 0; i < nodes.length; i++){
        if(compId[i] !== -1) continue;
        const stack = [i];
        compId[i] = c;
        while(stack.length){
          const u = stack.pop();
          adjacency[u].forEach(function(e){
            if(compId[e.to] === -1){ compId[e.to] = c; stack.push(e.to); }
          });
        }
        c++;
      }
      return { compId, count: c };
    }

    let { compId, count } = componentsOf();
    let guard = nodes.length; // hard cap so a data oddity can't infinite-loop
    while(count > 1 && guard-- > 0){
      let best = null;
      for(let i = 0; i < nodes.length; i++){
        for(let j = i + 1; j < nodes.length; j++){
          if(compId[i] === compId[j]) continue;
          const d = metersBetween(nodes[i].lat, nodes[i].lng, nodes[j].lat, nodes[j].lng);
          if(!best || d < best.d) best = { i: i, j: j, d: d };
        }
      }
      if(!best) break;
      addEdge(best.i, best.j, best.d, true);
      ({ compId, count } = componentsOf());
    }

    return { nodes, adjacency };
  }

  function getGraphForSite(site){
    if(!graphCache[site]) graphCache[site] = buildGraphForSite(site);
    return graphCache[site];
  }

  // Nearest graph node to an arbitrary lat/lng, within maxDist meters.
  // Returns { index, dist } or null if nothing is close enough — this is
  // what lets routing decide "there's no path network anywhere near this
  // place" and fall back to a straight line instead of forcing a bad snap.
  function nearestNode(graph, lat, lng, maxDist){
    let best = null, bestDist = Infinity;
    graph.nodes.forEach(function(n, i){
      const d = metersBetween(n.lat, n.lng, lat, lng);
      if(d < bestDist){ bestDist = d; best = i; }
    });
    if(best === null || bestDist > maxDist) return null;
    return { index: best, dist: bestDist };
  }

  // Same idea as nearestNode, but checks every vertex of a footprint
  // (building corners, or the single point for a landmark) instead of one
  // fixed lat/lng — so routing snaps from whichever edge of a building is
  // actually closest to the path network, not from its centroid.
  function nearestNodeToFootprint(graph, footprint, maxDist){
    let best = null, bestDist = Infinity, bestPoint = null;
    (footprint || []).forEach(function(pt){
      graph.nodes.forEach(function(n, i){
        const d = metersBetween(n.lat, n.lng, pt[0], pt[1]);
        if(d < bestDist){ bestDist = d; best = i; bestPoint = pt; }
      });
    });
    if(best === null || bestDist > maxDist) return null;
    return { index: best, dist: bestDist, point: bestPoint };
  }

  // Bidirectional Dijkstra: search outward from the start AND backward from
  // the end at the same time, alternating whichever frontier is currently
  // "cheaper" to expand, until the two searches meet. This explores a much
  // smaller slice of the graph than a single one-sided search (which has to
  // fan out until it stumbles onto the destination), and it's exact — the
  // stopping rule below (stop once frontierF + frontierB >= best meeting
  // distance found so far) guarantees the shortest path, not an
  // approximation. Every path segment you've traced is one connected graph
  // per site (see buildGraphForSite's component-stitching pass), so this
  // runs over the whole network at once rather than per-segment.
  function bidirectionalDijkstra(graph, startIdx, endIdx){
    const n = graph.nodes.length;
    if(startIdx === endIdx) return { path: [startIdx], dist: 0, bridgedHops: 0 };

    const distF = new Array(n).fill(Infinity), prevF = new Array(n).fill(null), bridgedF = new Array(n).fill(false), visitedF = new Array(n).fill(false);
    const distB = new Array(n).fill(Infinity), prevB = new Array(n).fill(null), bridgedB = new Array(n).fill(false), visitedB = new Array(n).fill(false);
    distF[startIdx] = 0;
    distB[endIdx] = 0;

    let mu = Infinity, meetNode = -1;

    function pickNext(dist, visited){
      let u = -1, best = Infinity;
      for(let i = 0; i < n; i++){
        if(!visited[i] && dist[i] < best){ best = dist[i]; u = i; }
      }
      return u;
    }

    for(let iter = 0; iter < n; iter++){
      const uF = pickNext(distF, visitedF);
      const uB = pickNext(distB, visitedB);
      if(uF === -1 && uB === -1) break;
      const nextF = uF === -1 ? Infinity : distF[uF];
      const nextB = uB === -1 ? Infinity : distB[uB];
      if(nextF + nextB >= mu) break; // frontiers can't beat the best meeting point already found

      if(nextF <= nextB && uF !== -1){
        visitedF[uF] = true;
        if(visitedB[uF] && distF[uF] + distB[uF] < mu){ mu = distF[uF] + distB[uF]; meetNode = uF; }
        graph.adjacency[uF].forEach(function(edge){
          if(visitedF[edge.to]) return;
          const alt = distF[uF] + edge.dist;
          if(alt < distF[edge.to]){
            distF[edge.to] = alt; prevF[edge.to] = uF; bridgedF[edge.to] = !!edge.bridged;
          }
          if(visitedB[edge.to] && alt + distB[edge.to] < mu){ mu = alt + distB[edge.to]; meetNode = edge.to; }
        });
      } else if(uB !== -1){
        visitedB[uB] = true;
        if(visitedF[uB] && distB[uB] + distF[uB] < mu){ mu = distB[uB] + distF[uB]; meetNode = uB; }
        graph.adjacency[uB].forEach(function(edge){
          if(visitedB[edge.to]) return;
          const alt = distB[uB] + edge.dist;
          if(alt < distB[edge.to]){
            distB[edge.to] = alt; prevB[edge.to] = uB; bridgedB[edge.to] = !!edge.bridged;
          }
          if(visitedF[edge.to] && alt + distF[edge.to] < mu){ mu = alt + distF[edge.to]; meetNode = edge.to; }
        });
      } else break;
    }

    if(meetNode === -1) return null;

    // Forward half: start ... meetNode
    const path = [];
    let bridgedHops = 0;
    let cur = meetNode;
    while(cur !== null){
      path.unshift(cur);
      if(bridgedF[cur]) bridgedHops++;
      cur = prevF[cur];
    }
    // Backward half: meetNode ... end (prevB[v] always points toward endIdx)
    cur = meetNode;
    while(cur !== endIdx){
      const next = prevB[cur];
      if(next === null) break;
      if(bridgedB[cur]) bridgedHops++;
      path.push(next);
      cur = next;
    }
    return { path: path, dist: mu, bridgedHops: bridgedHops };
  }

  // Every distinct graph node close enough to count as reachable from a
  // footprint (a building's real entry point(s), or its raw outline as a
  // fallback), deduplicated by node index — if several footprint points
  // snap to the same node, keep only the smallest snap distance. This is
  // the candidate set a route is allowed to enter/leave through; it's
  // deliberately NOT collapsed to a single "closest" point here, because
  // the closest-in-isolation entrance isn't necessarily the one that
  // pairs best with the other end (see bestEntryPointRoute below).
  function footprintCandidateNodes(graph, footprint, maxDist){
    const byNode = new Map(); // nodeIndex -> { index, dist, point }
    (footprint || []).forEach(function(pt){
      graph.nodes.forEach(function(n, i){
        const d = metersBetween(n.lat, n.lng, pt[0], pt[1]);
        if(d > maxDist) return;
        const existing = byNode.get(i);
        if(!existing || d < existing.dist){
          byNode.set(i, { index: i, dist: d, point: pt });
        }
      });
    });
    return Array.from(byNode.values());
  }

  // The actual fix for "routes should stop at the nearest ENTRY POINT,
  // not wander to whichever one happens to be closest to a path in
  // isolation": a place can have several separate entrances (or a whole
  // traced entry line/loop, e.g. a stadium track), and independently
  // snapping each end of a route to its own single closest node can pick
  // two entrances that are far apart from EACH OTHER, even though each
  // looked optimal on its own — that's exactly how a route between two
  // buildings with many connecting paths ends up taking an absurd detour.
  // Instead: gather every plausible entrance-to-path connection point for
  // BOTH ends (footprintCandidateNodes), then run Dijkstra across every
  // start/end combination and keep whichever pairing minimizes the total
  // cost (snap-in distance + network walk + snap-out distance). Footprints
  // are small after deduplication (a handful of distinct nearby nodes), so
  // this exhaustive pairing is cheap even though it's O(candidates²).
  function bestEntryPointRoute(graph, fromFootprint, toFootprint, maxDist){
    const startCandidates = footprintCandidateNodes(graph, fromFootprint, maxDist);
    const endCandidates = footprintCandidateNodes(graph, toFootprint, maxDist);
    if(!startCandidates.length || !endCandidates.length){
      return { ok: false, reason: 'unsnapped' };
    }

    let best = null;
    startCandidates.forEach(function(s){
      endCandidates.forEach(function(e){
        if(s.index === e.index){
          const total = s.dist + e.dist;
          if(!best || total < best.total){
            best = { total: total, start: s, end: e, path: [s.index], dist: 0, bridgedHops: 0 };
          }
          return;
        }
        const result = bidirectionalDijkstra(graph, s.index, e.index);
        if(!result) return;
        const total = s.dist + result.dist + e.dist;
        if(!best || total < best.total){
          best = { total: total, start: s, end: e, path: result.path, dist: result.dist, bridgedHops: result.bridgedHops };
        }
      });
    });

    if(!best) return { ok: false, reason: 'disconnected' };
    return Object.assign({ ok: true, reason: null }, best);
  }

  // All named places for the current site: every building (by centroid),
  // plus any landmark not already represented by a building — filtered to
  // ones that actually fall inside this site's boundary (if one is drawn).
  function getLocationsForSite(site){
    const locs = [];
    const usedLandmarkIds = new Set();
    siteData.buildings.forEach(function(b){
      if(b.site !== site) return;
      const latlngs = b.points.map(p => L.latLng(p[0], p[1]));
      const center = L.latLngBounds(latlngs).getCenter();
      const displayName = (b.name || 'Unnamed building') + (b.floor ? ' (' + b.floor + ')' : '');
      // If real entry point(s) have been placed, route to/from whichever of
      // THOSE points is closest — a small footprint of just the real
      // entrances — instead of letting routing pick whichever building
      // vertex happens to be nearest a path (which is how a circular
      // stadium ends up routing through the middle of its own track).
      // Marker + heading use the bounds-center of the entry points, so what
      // you see on the map is a sensible label position even with several
      // entrances; the actual routing target is still the nearest single
      // entry point (see nearestNodeToFootprint).
      const hasEntry = b.entry && b.entry.points.length;
      const usePoint = hasEntry
        ? L.latLngBounds(b.entry.points.map(p => L.latLng(p[0], p[1]))).getCenter()
        : center;
      locs.push({
        name: displayName, lat: usePoint.lat, lng: usePoint.lng,
        footprint: hasEntry
          ? (b.entry.connected ? densifyEntryLine(b.entry.points, b.entry.closed) : b.entry.points)
          : b.points
      });
      if(b.landmarkId) usedLandmarkIds.add(b.landmarkId);
    });
    const boundary = siteData[site].boundary;
    const corners = boundary ? cornersFromStored(boundary) : null;
    siteData.landmarks.forEach(function(l){
      if(usedLandmarkIds.has(l.id)) return;
      if(corners && !pointInPolygon(l.lat, l.lng, corners)) return;
      const displayName = l.name + (l.floor ? ' (' + l.floor + ')' : '');
      const hasEntry = l.entry && l.entry.points.length;
      const usePoint = hasEntry
        ? L.latLngBounds(l.entry.points.map(p => L.latLng(p[0], p[1]))).getCenter()
        : { lat: l.lat, lng: l.lng };
      locs.push({
        name: displayName, lat: usePoint.lat, lng: usePoint.lng,
        footprint: hasEntry
          ? (l.entry.connected ? densifyEntryLine(l.entry.points, l.entry.closed) : l.entry.points)
          : [[usePoint.lat, usePoint.lng]]
      });
    });
    locs.sort((a, b) => a.name.localeCompare(b.name));
    return locs;
  }

  function populateDirectionSelects(){
    const locs = getLocationsForSite(currentSite);
    [dirFromEl, dirToEl].forEach(function(sel, idx){
      const prevValue = sel.value;
      sel.innerHTML = '';
      if(locs.length === 0){
        const opt = document.createElement('option');
        opt.textContent = 'No named places yet';
        sel.appendChild(opt);
        sel.disabled = true;
        return;
      }
      sel.disabled = false;
      locs.forEach(function(loc, i){
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = loc.name;
        sel.appendChild(opt);
      });
      // Default "To" to the second entry so From/To aren't the same place.
      const fallback = idx === 1 && locs.length > 1 ? '1' : '0';
      sel.value = (prevValue && Number(prevValue) < locs.length) ? prevValue : fallback;
    });
    btnShowRoute.disabled = locs.length < 2;
  }

  function bearingBetween(a, b){
    const lat1 = a.lat * Math.PI / 180, lat2 = b.lat * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function compassLabel(deg){
    const dirs = ['N','NE','E','SE','S','SW','W','NW'];
    return dirs[Math.round(deg / 45) % 8];
  }

  function clearRoute(){
    routeLayer.clearLayers();
    routeReadoutEl.style.display = 'none';
  }

  function showRoute(){
    const locs = getLocationsForSite(currentSite);
    const fromIdx = Number(dirFromEl.value), toIdx = Number(dirToEl.value);
    const from = locs[fromIdx], to = locs[toIdx];
    if(!from || !to){ return; }
    if(fromIdx === toIdx){
      setStatus('Pick two different places to get a route between them.');
      return;
    }
    routeLayer.clearLayers();
    const a = L.latLng(from.lat, from.lng), b = L.latLng(to.lat, to.lng);

    // Try the real path network first: snap both ends to the nearest
    // walking-path node (within CONNECT_THRESHOLD_METERS) and run Dijkstra
    // between them. Only fall back to a straight line if either end is too
    // far from any path, or the network doesn't actually connect them.
    const graph = getGraphForSite(currentSite);

    let usedPathNetwork = false;
    let totalMeters;
    let routeLatLngs = [a, b];
    let fallbackReason = null; // 'unsnapped' | 'disconnected'
    let bridgedHops = 0;
    // Where the route (and its endpoint pin) actually terminates. When a
    // place has real entry point(s) — especially a connected line/loop
    // traced around a track or building edge — this is the specific point
    // on that footprint the path network snapped to, NOT the label's
    // centroid. Without this, a stadium's route would cut straight across
    // the middle to the centroid marker instead of stopping at the traced
    // entrance, which defeats the whole point of setting an entry point.
    let routeStart = a, routeEnd = b;

    // Try every combination of "which entry point on the from side" x
    // "which entry point on the to side" and keep whichever pairing gives
    // the shortest total walk — not just whichever entry point each end
    // happens to be nearest to on its own (see bestEntryPointRoute).
    const routeResult = graph.nodes.length
      ? bestEntryPointRoute(graph, from.footprint, to.footprint, CONNECT_THRESHOLD_METERS)
      : { ok: false, reason: 'unsnapped' };

    if(routeResult.ok){
      usedPathNetwork = true;
      bridgedHops = routeResult.bridgedHops;
      routeStart = L.latLng(routeResult.start.point[0], routeResult.start.point[1]);
      routeEnd = L.latLng(routeResult.end.point[0], routeResult.end.point[1]);
      const nodeLatLngs = routeResult.path.map(i => L.latLng(graph.nodes[i].lat, graph.nodes[i].lng));
      routeLatLngs = [routeStart].concat(nodeLatLngs, [routeEnd]);
      totalMeters = routeResult.total;
    } else {
      fallbackReason = routeResult.reason;
    }

    if(usedPathNetwork){
      L.polyline(routeLatLngs, { color: '#4fb3a9', weight: 4, opacity: 0.95 }).addTo(routeLayer);
    } else {
      L.polyline([a, b], { color: '#e08e45', weight: 3, dashArray: '8,8' }).addTo(routeLayer);
      totalMeters = a.distanceTo(b);
    }

    L.circleMarker(routeStart, { radius: 7, color: '#4fb3a9', fillColor: '#4fb3a9', fillOpacity: 1, weight: 2 })
      .bindTooltip(from.name, { permanent: false }).addTo(routeLayer);
    L.circleMarker(routeEnd, { radius: 7, color: '#d9634f', fillColor: '#d9634f', fillOpacity: 1, weight: 2 })
      .bindTooltip(to.name, { permanent: false }).addTo(routeLayer);
    map.fitBounds(L.latLngBounds(routeLatLngs), { maxZoom: map.getMaxZoom(), padding: [60, 60] });

    const distText = totalMeters >= 1000 ? (totalMeters / 1000).toFixed(2) + ' km' : Math.round(totalMeters) + ' m';
    const walkMins = Math.max(1, Math.round(totalMeters / 80)); // ~4.8 km/h walking pace
    const heading = compassLabel(bearingBetween(from, to));
    routeReadoutEl.style.display = 'block';
    routeReadoutEl.textContent = usedPathNetwork
      ? (from.name + ' → ' + to.name + ': ' + distText + ' via paths, overall heading ' + heading + ', ~' + walkMins + ' min walk.' +
         (bridgedHops > 0 ? ' (crosses ' + bridgedHops + ' untraced gap' + (bridgedHops > 1 ? 's' : '') + ' between your path segments — straight-line estimate for those stretches.)' : ''))
      : (from.name + ' → ' + to.name + ': ' + distText + ' straight-line (' +
         (fallbackReason === 'disconnected'
           ? 'nearest traced paths for these two aren\'t connected to each other'
           : 'one of these is too far from any traced path') +
         '), heading ' + heading + ', ~' + walkMins + ' min walk.');
  }

  btnShowRoute.addEventListener('click', showRoute);
  btnClearRoute.addEventListener('click', function(){
    clearRoute();
    setStatus('Route cleared.');
  });

  // ================= SITE TOGGLE =================
  function switchSite(site){
    if(drawingBoundary) cancelBoundaryDraw();
    if(drawingBuilding) cancelBuildingDraw();

    currentSite = site;
    tabCollege.classList.toggle('active', site === 'college');
    tabHostel.classList.toggle('active', site === 'hostel');

    renderBoundary();
    renderPaths();
    populateCategoryFilter();
    renderBuildings();
    clearRoute();
    populateDirectionSelects();

    const stored = siteData[currentSite].boundary;
    if(stored && siteData[currentSite].locked){
      const bounds = boundsFromCorners(cornersFromStored(stored));
      applyBoundaryConstraint(bounds);
      setStatus('Showing ' + site + '. Boundary is locked as the max view.');
    } else if(stored){
      releaseBoundaryConstraint();
      setStatus('Showing ' + site + '. Boundary is unlocked — free zoom/pan.');
    } else {
      releaseBoundaryConstraint();
      setStatus('Showing ' + site + '. No boundary set yet — draw one to lock the view.');
    }
    applyCompassLock();
  }

  tabCollege.addEventListener('click', function(){ switchSite('college'); });
  tabHostel.addEventListener('click', function(){ switchSite('hostel'); });

  // ================= INIT =================
  // The panel is now always a pure view (Directions + Buildings); there's
  // no more Setup/Navigate tab to default into. If there's tracing work
  // outstanding, surface it as a badge on Contribute → Trace Landmarks
  // instead of auto-opening anything.
  updateCompassUI();
  applyCompassLock();
  renderLandmarks();
  renderLandmarkList();

  if(!siteData.college.boundary && !siteData.hostel.boundary && siteData.landmarks.length){
    const avgLat = siteData.landmarks.reduce((s,l)=>s+l.lat,0) / siteData.landmarks.length;
    const avgLng = siteData.landmarks.reduce((s,l)=>s+l.lng,0) / siteData.landmarks.length;
    map.setView([avgLat, avgLng], 17);
  }
  switchSite('college');

})();
