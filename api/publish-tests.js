// Vercel serverless function — multi-project aware.
//
// GET  /api/publish-tests?project=<id>      → current tests array + commit sha for that project
// POST /api/publish-tests
//   { project, changedTests, deletedIds, author } → delta merge into data/<project>.json
//
// If no project is passed, defaults to "crescent-sap-transformation" (backwards compat
// with the pre-multi-project client).

const REPO_OWNER = "juangarza918";
const REPO_NAME  = "Crescent-SAP-Transformation";
const DEFAULT_PROJECT = "crescent-sap-transformation";
const ALLOWED_ORIGINS = [
  "https://crescent-sap-transformation.vercel.app",
  "http://localhost:8765",
];

function filePath(project) {
  const safe = String(project || DEFAULT_PROJECT).replace(/[^a-z0-9._-]/gi, "").slice(0, 80);
  return `data/${safe || DEFAULT_PROJECT}.json`;
}
function api(project) {
  return `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath(project)}`;
}

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.send(JSON.stringify(body));
}

async function ghFetch(url, opts = {}) {
  const token = process.env.GITHUB_TOKEN;
  const headers = Object.assign({
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "crescent-sap-dashboard",
  }, opts.headers || {});
  return fetch(url, Object.assign({}, opts, { headers }));
}

async function fetchCurrent(project) {
  const getResp = await ghFetch(`${api(project)}?ref=main`);
  if (!getResp.ok) {
    const txt = await getResp.text();
    throw new Error(`GET ${filePath(project)} failed (${getResp.status}): ${txt.slice(0, 200)}`);
  }
  const info = await getResp.json();
  const sha = info.sha;
  const doc = JSON.parse(Buffer.from(info.content, "base64").toString("utf8"));
  return { doc, sha };
}

async function fetchAndMerge(project, changedTests, deletedIds) {
  const { doc, sha } = await fetchCurrent(project);
  const currentTests = Array.isArray(doc.tests) ? doc.tests : [];
  const byId = new Map(currentTests.map((t) => [t.id, t]));
  (changedTests || []).forEach((ct) => { if (ct && ct.id) byId.set(ct.id, ct); });
  (deletedIds || []).forEach((id) => byId.delete(id));
  const mergedTests = Array.from(byId.values());
  doc.tests = mergedTests;
  return { doc, sha, tests: mergedTests };
}

async function commitMerged(project, merged, author, retriesLeft) {
  const putResp = await ghFetch(api(project), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `[${project}] Update tests via dashboard (${author})`,
      content: Buffer.from(JSON.stringify(merged.doc, null, 2)).toString("base64"),
      sha: merged.sha,
      branch: "main",
    }),
  });
  if (putResp.status === 409 && retriesLeft > 0) {
    const fresh = await fetchAndMerge(project, merged.changed, merged.deleted);
    fresh.changed = merged.changed; fresh.deleted = merged.deleted;
    return commitMerged(project, fresh, author, retriesLeft - 1);
  }
  if (!putResp.ok) {
    const txt = await putResp.text();
    throw new Error(`PUT ${filePath(project)} failed (${putResp.status}): ${txt.slice(0, 200)}`);
  }
  return putResp.json();
}

module.exports = async (req, res) => {
  const origin = req.headers.origin || "";
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (origin && !ALLOWED_ORIGINS.some((o) => origin.startsWith(o))) {
    return json(res, 403, { error: `Forbidden origin: ${origin}` });
  }
  if (!process.env.GITHUB_TOKEN) {
    return json(res, 500, { error: "Server is missing GITHUB_TOKEN env var." });
  }

  // GET: fetch the freshest tests for a project
  if (req.method === "GET") {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const project = u.searchParams.get("project") || DEFAULT_PROJECT;
    try {
      const { doc, sha } = await fetchCurrent(project);
      const tests = Array.isArray(doc.tests) ? doc.tests : [];
      return json(res, 200, { project, tests, commit: sha, testsCount: tests.length });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const project = body.project || DEFAULT_PROJECT;
  let changedTests, deletedIds;
  if (Array.isArray(body.changedTests) || Array.isArray(body.deletedIds)) {
    changedTests = Array.isArray(body.changedTests) ? body.changedTests : [];
    deletedIds   = Array.isArray(body.deletedIds)   ? body.deletedIds   : [];
    if (changedTests.length === 0 && deletedIds.length === 0) {
      return json(res, 200, { success: true, tests: null, noop: true });
    }
  } else if (Array.isArray(body.tests)) {
    changedTests = body.tests; deletedIds = [];
  } else {
    return json(res, 400, { error: "Body must include `changedTests`+`deletedIds` or legacy `tests`." });
  }

  if (changedTests.length > 5000) return json(res, 413, { error: "Too many tests in one save (>5000)." });

  const author = String(body.author || "anonymous")
    .replace(/[^\w\s.@-]/g, "").slice(0, 100) || "anonymous";

  try {
    const merged = await fetchAndMerge(project, changedTests, deletedIds);
    merged.changed = changedTests; merged.deleted = deletedIds;
    const result = await commitMerged(project, merged, author, 3);
    return json(res, 200, {
      success: true,
      project,
      commit: (result.commit || {}).sha,
      tests: merged.tests,
      testsCount: merged.tests.length,
    });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
};
