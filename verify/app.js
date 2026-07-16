(function(){
  "use strict";

  var BAKED = window.BAKED_DATA;
  var GITHUB_REPO = 'accelerate-muj/campus-mapper';

  // ================= MAP =================
  var map = L.map('map', {
    minZoom: 2, maxZoom: 20, zoomSnap: 0.1, zoomDelta: 1,
    renderer: L.svg({ padding: 1.5 })
  }).setView([26.8443, 75.5653], 16);

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 20,
    attribution: 'Tiles &copy; Esri'
  }).addTo(map);

  // ================= LAYERS =================
  var existingLayer = L.layerGroup().addTo(map);
  var submittedLayer = L.layerGroup().addTo(map);
  var boundaryLayer = L.layerGroup().addTo(map);

  // ================= STATE =================
  var submittedData = { buildings: [], landmarks: [], paths: [] };

  // ================= RENDER EXISTING DATA =================
  function renderExisting(){
    existingLayer.clearLayers();
    boundaryLayer.clearLayers();

    // Boundaries
    ['college','hostel'].forEach(function(site){
      var s = BAKED[site];
      if(!s || !s.boundary) return;
      var corners = s.boundary;
      if(corners.length === 2){
        var sw = corners[0], ne = corners[1];
        corners = [[sw[0],sw[1]],[sw[0],ne[1]],[ne[0],ne[1]],[ne[0],sw[1]]];
      }
      L.polygon(corners, {
        color: '#e08e45', weight: 2, fillOpacity: 0.02, dashArray: '4,4'
      }).addTo(boundaryLayer);
    });

    // Buildings
    (BAKED.buildings || []).forEach(function(b){
      if(!b.points || b.points.length < 3) return;
      var latlngs = b.points.map(function(p){ return L.latLng(p[0], p[1]); });
      var poly = L.polygon(latlngs, {
        color: '#93a1ab', weight: 1.5, fillColor: '#93a1ab', fillOpacity: 0.12, dashArray: '3,3'
      }).addTo(existingLayer);
      poly.bindTooltip((b.name || 'Building') + ' (existing)', { sticky: true });
    });

    // Landmarks
    (BAKED.landmarks || []).forEach(function(lm){
      if(lm.resolved) return;
      L.circleMarker([lm.lat, lm.lng], {
        radius: 5, color: '#93a1ab', fillColor: '#93a1ab', fillOpacity: 0.3, weight: 1, dashArray: '2,2'
      }).bindTooltip((lm.name || 'Landmark') + ' (existing)', { sticky: true }).addTo(existingLayer);
    });

    // Paths
    (BAKED.paths || []).forEach(function(p){
      if(!p.points || p.points.length < 2) return;
      var latlngs = p.points.map(function(pt){ return L.latLng(pt[0], pt[1]); });
      L.polyline(latlngs, {
        color: '#93a1ab', weight: 1.5, opacity: 0.4, dashArray: '2,4'
      }).bindTooltip((p.name || 'Path') + ' (existing)', { sticky: true }).addTo(existingLayer);
    });
  }

  // ================= RENDER SUBMITTED DATA =================
  function renderSubmitted(){
    submittedLayer.clearLayers();
    var statsEl = document.getElementById('stats');
    var total = submittedData.buildings.length + submittedData.landmarks.length + submittedData.paths.length;
    if(total === 0){ statsEl.classList.add('hidden'); return; }
    statsEl.classList.remove('hidden');
    document.getElementById('statBuildings').textContent = submittedData.buildings.length;
    document.getElementById('statLandmarks').textContent = submittedData.landmarks.length;
    document.getElementById('statPaths').textContent = submittedData.paths.length;

    // Buildings
    submittedData.buildings.forEach(function(b){
      if(!b.points || b.points.length < 3) return;
      var latlngs = b.points.map(function(p){ return L.latLng(p[0], p[1]); });
      var poly = L.polygon(latlngs, {
        color: '#4fb3a9', weight: 3, fillColor: '#4fb3a9', fillOpacity: 0.25
      }).addTo(submittedLayer);
      poly.bindTooltip((b.name || 'Building') + ' (submitted)', { sticky: true });
      poly.on('click', function(){
        map.fitBounds(poly.getBounds(), { maxZoom: 19 });
      });
    });

    // Landmarks
    submittedData.landmarks.forEach(function(lm){
      var marker = L.circleMarker([lm.lat, lm.lng], {
        radius: 8, color: '#e08e45', fillColor: '#e08e45', fillOpacity: 0.9, weight: 3
      }).addTo(submittedLayer);
      marker.bindTooltip((lm.name || 'Landmark') + ' (submitted)', { sticky: true });
      marker.on('click', function(){
        map.setView([lm.lat, lm.lng], 19);
      });
    });

    // Paths
    submittedData.paths.forEach(function(p){
      if(!p.points || p.points.length < 2) return;
      var latlngs = p.points.map(function(pt){ return L.latLng(pt[0], pt[1]); });
      var line = L.polyline(latlngs, {
        color: '#e0c145', weight: 3, opacity: 0.9
      }).addTo(submittedLayer);
      line.bindTooltip((p.name || 'Path') + ' (submitted)', { sticky: true });
    });
  }

  // ================= VALIDATION =================
  function getBoundaryCorners(site){
    var s = BAKED[site];
    if(!s || !s.boundary) return null;
    var c = s.boundary;
    if(c.length === 2){
      var sw = c[0], ne = c[1];
      return [[sw[0],sw[1]],[sw[0],ne[1]],[ne[0],ne[1]],[ne[0],sw[1]]];
    }
    return c;
  }

  function pointInPolygon(lat, lng, corners){
    var inside = false;
    for(var i = 0, j = corners.length - 1; i < corners.length; j = i++){
      var xi = corners[i][1], yi = corners[i][0];
      var xj = corners[j][1], yj = corners[j][0];
      var intersect = ((yi > lat) !== (yj > lat)) &&
        (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
      if(intersect) inside = !inside;
    }
    return inside;
  }

  function polygonInsideBoundary(points, site){
    var corners = getBoundaryCorners(site);
    if(!corners) return true;
    return points.every(function(p){ return pointInPolygon(p[0], p[1], corners); });
  }

  function validate(){
    var results = [];
    var passCount = 0, failCount = 0, warnCount = 0;

    function addResult(type, pass, msg, detail){
      results.push({ type: type, pass: pass, msg: msg, detail: detail || null });
      if(pass === 'pass') passCount++;
      else if(pass === 'fail') failCount++;
      else warnCount++;
    }

    var total = submittedData.buildings.length + submittedData.landmarks.length + submittedData.paths.length;
    if(total === 0){
      addResult('warn', 'warn', 'No submitted data', 'Paste or upload JSON to validate.');
      return { results: results, pass: passCount, fail: failCount, warn: warnCount };
    }

    // Check structure
    addResult('info', 'pass', total + ' item(s) submitted',
      submittedData.buildings.length + ' buildings, ' + submittedData.landmarks.length + ' landmarks, ' + submittedData.paths.length + ' paths');

    // Validate buildings
    var existingIds = new Set();
    (BAKED.buildings || []).forEach(function(b){ if(b.id) existingIds.add(b.id); });
    (BAKED.landmarks || []).forEach(function(l){ if(l.id) existingIds.add(l.id); });

    submittedData.buildings.forEach(function(b, i){
      var label = b.name || ('Building #' + (i + 1));
      if(!b.id) addResult('fail', 'fail', label + ': missing id', 'Each building needs a unique id field.');
      else if(existingIds.has(b.id)) addResult('fail', 'fail', label + ': duplicate id "' + b.id + '"', 'This id already exists in mapData.js.');
      else existingIds.add(b.id);

      if(!b.name) addResult('warn', 'warn', label + ': no name', 'Buildings should have a name.');

      if(!b.points || !Array.isArray(b.points)){
        addResult('fail', 'fail', label + ': missing points', 'Building needs a points array of [lat, lng] pairs.');
      } else {
        if(b.points.length < 3) addResult('fail', 'fail', label + ': needs 3+ points', 'Got ' + b.points.length + ' point(s).');
        b.points.forEach(function(p, pi){
          if(!Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number'){
            addResult('fail', 'fail', label + ': invalid point #' + (pi + 1), 'Expected [lat, lng] numbers, got: ' + JSON.stringify(p));
          }
        });
        if(b.site && !polygonInsideBoundary(b.points, b.site)){
          addResult('warn', 'warn', label + ': outside ' + b.site + ' boundary', 'Some points fall outside the campus boundary.');
        }
      }

      if(b.site && b.site !== 'college' && b.site !== 'hostel'){
        addResult('warn', 'warn', label + ': unknown site "' + b.site + '"', 'Expected "college" or "hostel".');
      }
    });

    // Validate landmarks
    submittedData.landmarks.forEach(function(lm, i){
      var label = lm.name || ('Landmark #' + (i + 1));
      if(!lm.id) addResult('fail', 'fail', label + ': missing id', 'Each landmark needs a unique id field.');
      else if(existingIds.has(lm.id)) addResult('fail', 'fail', label + ': duplicate id "' + lm.id + '"', 'This id already exists in mapData.js.');
      else existingIds.add(lm.id);

      if(!lm.name) addResult('warn', 'warn', label + ': no name', 'Landmarks should have a name.');

      if(typeof lm.lat !== 'number' || typeof lm.lng !== 'number'){
        addResult('fail', 'fail', label + ': missing lat/lng', 'Landmark needs numeric lat and lng fields.');
      }
    });

    // Validate paths
    submittedData.paths.forEach(function(p, i){
      var label = p.name || ('Path #' + (i + 1));
      if(!p.id) addResult('fail', 'fail', label + ': missing id', 'Each path needs a unique id field.');
      else if(existingIds.has(p.id)) addResult('fail', 'fail', label + ': duplicate id "' + p.id + '"', 'This id already exists in mapData.js.');
      else existingIds.add(p.id);

      if(!p.points || !Array.isArray(p.points)){
        addResult('fail', 'fail', label + ': missing points', 'Path needs a points array of [lat, lng] pairs.');
      } else {
        if(p.points.length < 2) addResult('fail', 'fail', label + ': needs 2+ points', 'Got ' + p.points.length + ' point(s).');
      }
    });

    return { results: results, pass: passCount, fail: failCount, warn: warnCount };
  }

  function renderValidation(v){
    var panel = document.getElementById('validationPanel');
    var body = document.getElementById('validationResults');
    panel.classList.remove('hidden');
    body.innerHTML = '';

    var summary = document.createElement('div');
    summary.className = 'val-summary';
    summary.innerHTML = '<span class="pass-count">✓ ' + v.pass + ' passed</span>' +
      '<span class="fail-count">✗ ' + v.fail + ' failed</span>' +
      '<span class="warn-count">⚠ ' + v.warn + ' warnings</span>';
    body.appendChild(summary);

    v.results.forEach(function(r){
      var item = document.createElement('div');
      item.className = 'val-item';
      var iconClass = r.pass === 'pass' ? 'pass' : r.pass === 'fail' ? 'fail' : 'warn';
      var iconSymbol = r.pass === 'pass' ? '✓' : r.pass === 'fail' ? '✗' : '⚠';
      item.innerHTML = '<span class="val-icon ' + iconClass + '">' + iconSymbol + '</span>' +
        '<div><div class="val-text">' + r.msg + '</div>' +
        (r.detail ? '<div class="val-detail">' + r.detail + '</div>' : '') + '</div>';
      body.appendChild(item);
    });

    if(v.fail === 0 && v.results.length > 1){
      var approve = document.createElement('div');
      approve.style.cssText = 'margin-top:12px; padding-top:10px; border-top:1px solid var(--line);';
      approve.innerHTML = '<button id="approveBtn" class="btn btn-success" style="width:100%; justify-content:center;">✓ All checks passed — Ready to merge</button>';
      body.appendChild(approve);
    }
  }

  // ================= JSON IMPORT =================
  function parseAndLoad(text){
    var statusEl = document.getElementById('importStatus');
    statusEl.className = 'import-status';
    submittedData = { buildings: [], landmarks: [], paths: [] };

    var parsed;
    try { parsed = JSON.parse(text); } catch(e){
      statusEl.className = 'import-status error';
      statusEl.textContent = 'Invalid JSON: ' + e.message;
      renderSubmitted();
      return;
    }

    // Accept both array and object with buildings/landmarks/paths keys
    if(Array.isArray(parsed)){
      // Auto-detect type from fields
      parsed.forEach(function(item){
        if(item.points && item.lat === undefined && Array.isArray(item.points) && item.points.length >= 3 && item.points[0] && Array.isArray(item.points[0])){
          submittedData.buildings.push(item);
        } else if(typeof item.lat === 'number' && typeof item.lng === 'number'){
          submittedData.landmarks.push(item);
        } else if(item.points && Array.isArray(item.points)){
          submittedData.paths.push(item);
        }
      });
    } else if(parsed && typeof parsed === 'object'){
      if(Array.isArray(parsed.buildings)) submittedData.buildings = parsed.buildings;
      if(Array.isArray(parsed.landmarks)) submittedData.landmarks = parsed.landmarks;
      if(Array.isArray(parsed.paths)) submittedData.paths = parsed.paths;
      // Also handle single-item objects
      if(!submittedData.buildings.length && !submittedData.landmarks.length && !submittedData.paths.length){
        if(parsed.points && typeof parsed.lat !== 'number'){
          submittedData.buildings.push(parsed);
        } else if(typeof parsed.lat === 'number'){
          submittedData.landmarks.push(parsed);
        }
      }
    }

    var total = submittedData.buildings.length + submittedData.landmarks.length + submittedData.paths.length;
    if(total === 0){
      statusEl.className = 'import-status error';
      statusEl.textContent = 'No valid items found. Expected array of buildings/landmarks/paths.';
    } else {
      statusEl.className = 'import-status success';
      statusEl.textContent = 'Loaded ' + total + ' item(s) — click Validate to check.';
    }
    renderSubmitted();
  }

  // ================= UI WIRING =================
  var jsonInput = document.getElementById('jsonInput');
  var fileInput = document.getElementById('fileInput');
  var loadFileBtn = document.getElementById('loadFileBtn');
  var clearBtn = document.getElementById('clearBtn');
  var validateBtn = document.getElementById('validateBtn');
  var togglePanel = document.getElementById('togglePanel');
  var importPanel = document.getElementById('importPanel');
  var closeValidation = document.getElementById('closeValidation');
  var toggleExisting = document.getElementById('toggleExisting');
  var toggleSubmitted = document.getElementById('toggleSubmitted');

  loadFileBtn.addEventListener('click', function(){ fileInput.click(); });
  fileInput.addEventListener('change', function(e){
    var file = e.target.files[0];
    if(!file) return;
    var reader = new FileReader();
    reader.onload = function(ev){
      jsonInput.value = ev.target.result;
      parseAndLoad(ev.target.result);
    };
    reader.readAsText(file);
    fileInput.value = '';
  });

  jsonInput.addEventListener('input', function(){
    var val = jsonInput.value.trim();
    if(val) parseAndLoad(val);
  });

  clearBtn.addEventListener('click', function(){
    jsonInput.value = '';
    submittedData = { buildings: [], landmarks: [], paths: [] };
    document.getElementById('importStatus').textContent = '';
    document.getElementById('importStatus').className = 'import-status';
    document.getElementById('stats').classList.add('hidden');
    document.getElementById('validationPanel').classList.add('hidden');
    renderSubmitted();
  });

  validateBtn.addEventListener('click', function(){
    var v = validate();
    renderValidation(v);
  });

  togglePanel.addEventListener('click', function(){
    importPanel.classList.toggle('collapsed');
    togglePanel.querySelector('i').className = importPanel.classList.contains('collapsed')
      ? 'fas fa-chevron-up' : 'fas fa-chevron-down';
  });

  closeValidation.addEventListener('click', function(){
    document.getElementById('validationPanel').classList.add('hidden');
  });

  toggleExisting.addEventListener('change', function(){
    if(toggleExisting.checked){ map.addLayer(existingLayer); map.addLayer(boundaryLayer); }
    else { map.removeLayer(existingLayer); map.removeLayer(boundaryLayer); }
  });

  toggleSubmitted.addEventListener('change', function(){
    if(toggleSubmitted.checked) map.addLayer(submittedLayer);
    else map.removeLayer(submittedLayer);
  });

  // ================= INIT =================
  renderExisting();

})();
