'use strict';

/**
 * Pure parsing and validation for map-contribution issue bodies.
 *
 * No file or network access lives here, so this module can be exercised
 * directly by tests/contribution-parser.test.js in either Node or a browser.
 * The I/O half lives in process-contribution.js.
 *
 * Everything this module reads is written by an arbitrary GitHub user, so
 * nothing is trusted. Two properties matter most, and both are covered by
 * tests:
 *
 *   - Target paths are DERIVED from validated parts. The issue's `**File:**`
 *     line is ignored; honouring it let a contribution overwrite any repo file.
 *   - Every returned string matches a strict pattern, so no contributor value
 *     can carry a newline or shell metacharacter into the workflow.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ContributionParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SITES = Object.freeze(['college', 'hostel']);
  const TYPES = Object.freeze(['building', 'landmark', 'path']);

  /**
   * A category becomes a filename, so it is constrained to a safe slug rather
   * than a fixed allowlist — custom categories are a supported feature.
   */
  const CATEGORY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

  const MAX_BODY_LENGTH = 200000;
  const MAX_NAME_LENGTH = 100;
  const MAX_POINTS = 2000;
  const MIN_POINTS = { building: 3, path: 2, entry: 1 };

  const DATA_DIR = 'data';

  /** A contributor's input was rejected. The message is safe to echo back. */
  class ContributionError extends Error {
    constructor(message) {
      super(message);
      this.name = 'ContributionError';
    }
  }

  function fail(message) {
    throw new ContributionError(message);
  }

  // ---------- reading the issue body ----------

  /** Reads a `**Label:** value` line. Returns null when absent. */
  function readField(body, label) {
    const match = body.match(new RegExp('\\*\\*' + label + ':\\*\\*[ \\t]*([^\\r\\n]*)'));
    return match ? match[1].trim() : null;
  }

  /** Reads the fenced ```json block holding the payload. */
  function readJsonBlock(body) {
    const match = body.match(/```json\s*\r?\n([\s\S]*?)\r?\n```/);
    if (!match) fail('No ```json block was found in the issue body.');

    try {
      return JSON.parse(match[1]);
    } catch (error) {
      fail('The JSON block is not valid JSON: ' + error.message);
    }
  }

  // ---------- field validation ----------

  function validateType(raw) {
    if (!raw) fail('Missing **Type:** — expected building, landmark, or path.');
    if (TYPES.indexOf(raw) === -1) fail('Invalid type "' + raw + '". Expected one of: ' + TYPES.join(', ') + '.');
    return raw;
  }

  function validateSite(raw) {
    if (!raw) return 'college';
    if (SITES.indexOf(raw) === -1) fail('Invalid site "' + raw + '". Expected one of: ' + SITES.join(', ') + '.');
    return raw;
  }

  function validateCategory(raw) {
    if (!raw) return 'other';
    if (!CATEGORY_RE.test(raw)) {
      fail('Invalid category "' + raw + '". Use lowercase letters, digits and hyphens (max 32 chars).');
    }
    return raw;
  }

  function validateId(raw) {
    if (raw === undefined || raw === null || raw === '') fail('Entry is missing an "id".');
    if (typeof raw !== 'string' || !ID_RE.test(raw)) {
      fail('Invalid id "' + raw + '". Use letters, digits, underscores and hyphens (max 64 chars).');
    }
    return raw;
  }

  function validateName(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') fail('Entry is missing a "name".');

    // Strip control characters, then collapse whitespace. A newline here would
    // otherwise break out of a line of Markdown or forge a `key=value` output.
    const name = Array.from(raw)
      .map(function (ch) {
        const code = ch.charCodeAt(0);
        return code <= 0x1f || code === 0x7f ? ' ' : ch;
      })
      .join('')
      .replace(/\s+/g, ' ')
      .trim();

    if (name === '') fail('Entry "name" is empty once whitespace is stripped.');
    if (name.length > MAX_NAME_LENGTH) fail('Entry "name" exceeds ' + MAX_NAME_LENGTH + ' characters.');
    return name;
  }

  function validateLatLng(lat, lng, where) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) fail(where + ': coordinates must be finite numbers.');
    if (lat < -90 || lat > 90) fail(where + ': latitude ' + lat + ' is outside -90..90.');
    if (lng < -180 || lng > 180) fail(where + ': longitude ' + lng + ' is outside -180..180.');
  }

  function validatePoints(points, kind, where) {
    const minimum = MIN_POINTS[kind] || 1;

    if (!Array.isArray(points)) fail(where + ': "points" must be an array.');
    if (points.length < minimum) fail(where + ': needs at least ' + minimum + ' points, got ' + points.length + '.');
    if (points.length > MAX_POINTS) fail(where + ': ' + points.length + ' points exceeds the ' + MAX_POINTS + ' limit.');

    points.forEach(function (pair, index) {
      if (!Array.isArray(pair) || pair.length !== 2) fail(where + ': point ' + index + ' must be a [lat, lng] pair.');
      validateLatLng(pair[0], pair[1], where + ' point ' + index);
    });
  }

  function validateEntry(entry) {
    if (entry === undefined || entry === null) return;
    if (typeof entry !== 'object' || Array.isArray(entry)) fail('"entry" must be an object or null.');
    if (entry.points !== undefined) validatePoints(entry.points, 'entry', 'entry');
  }

  function validateFloor(floor) {
    if (floor === undefined) return null;
    if (floor === null || typeof floor === 'string' || Number.isFinite(floor)) return floor;
    fail('"floor" must be a string, a number, or null.');
  }

  /**
   * Validates the payload and returns only the fields we are willing to write.
   * Unknown keys are dropped rather than merged, so a contribution cannot
   * smuggle extra fields into the data files.
   */
  function validateEntity(type, site, category, data) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      fail('The JSON block must contain a single object.');
    }

    const id = validateId(data.id);
    const floor = validateFloor(data.floor);
    validateEntry(data.entry);

    if (type === 'building') {
      const name = validateName(data.name);
      validatePoints(data.points, 'building', 'building');

      const entity = { id: id, name: name, site: site, category: category, points: data.points };

      // `landmarkId: null` is a real shape the app itself writes for a building
      // that was traced directly rather than expanded from a landmark. Treat it
      // as "no link", not as a malformed id.
      if (data.landmarkId !== undefined) {
        entity.landmarkId = data.landmarkId === null ? null : validateId(data.landmarkId);
      }
      if (data.entry !== undefined) entity.entry = data.entry;
      entity.floor = floor;

      return { name: name, entity: entity };
    }

    if (type === 'landmark') {
      const name = validateName(data.name);
      validateLatLng(data.lat, data.lng, 'landmark');

      return {
        name: name,
        entity: {
          id: id,
          name: name,
          lat: data.lat,
          lng: data.lng,
          site: site,
          category: category,
          resolved: data.resolved === true,
          entry: data.entry === undefined ? null : data.entry,
          floor: floor,
        },
      };
    }

    // Paths are unnamed geometry; a missing name is normal.
    validatePoints(data.points, 'path', 'path');
    const named = typeof data.name === 'string' && data.name.trim() !== '';
    const name = named ? validateName(data.name) : '';

    const entity = { id: id, site: site, points: data.points };
    if (name) entity.name = name;

    return { name: name, entity: entity };
  }

  // ---------- derived values ----------

  /**
   * Derives the destination from validated parts. The issue's `**File:**` line
   * is deliberately ignored: it is contributor-controlled and carries nothing
   * that is not already derivable here.
   */
  function deriveTargetFile(type, site, category) {
    if (type === 'building') return DATA_DIR + '/' + site + '/buildings/' + category + '.json';
    if (type === 'landmark') return DATA_DIR + '/' + site + '/landmarks.json';
    return DATA_DIR + '/' + site + '/paths.json';
  }

  /** Branch names are built from validated input only, never from a raw name. */
  function branchSlug(type, id) {
    return ('contribution/' + type + '/' + id.toLowerCase().replace(/[^a-z0-9._-]/g, '-')).slice(0, 60);
  }

  /**
   * Validates an issue body end to end and returns everything the workflow
   * needs. Throws ContributionError with a contributor-facing message.
   */
  function parseContribution(body) {
    if (typeof body !== 'string' || body.trim() === '') fail('The issue body is empty.');
    if (body.length > MAX_BODY_LENGTH) fail('The issue body is too large to process.');

    const type = validateType(readField(body, 'Type'));
    const site = validateSite(readField(body, 'Site'));
    const data = readJsonBlock(body);

    // The payload is the source of truth for category; the header line is a hint.
    const rawCategory = typeof data.category === 'string' ? data.category : readField(body, 'Category');
    const category = validateCategory(rawCategory);

    const validated = validateEntity(type, site, category, data);

    return {
      type: type,
      site: site,
      category: category,
      id: validated.entity.id,
      name: validated.name || validated.entity.id,
      entity: validated.entity,
      targetFile: deriveTargetFile(type, site, category),
      branch: branchSlug(type, validated.entity.id),
    };
  }

  return {
    CATEGORY_RE: CATEGORY_RE,
    ContributionError: ContributionError,
    DATA_DIR: DATA_DIR,
    ID_RE: ID_RE,
    MAX_NAME_LENGTH: MAX_NAME_LENGTH,
    MAX_POINTS: MAX_POINTS,
    SITES: SITES,
    TYPES: TYPES,
    branchSlug: branchSlug,
    deriveTargetFile: deriveTargetFile,
    parseContribution: parseContribution,
    readField: readField,
    readJsonBlock: readJsonBlock,
    validateCategory: validateCategory,
    validateEntity: validateEntity,
    validateId: validateId,
    validateName: validateName,
    validatePoints: validatePoints,
    validateSite: validateSite,
    validateType: validateType,
  };
});
