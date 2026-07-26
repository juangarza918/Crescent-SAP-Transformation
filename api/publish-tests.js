// Vercel serverless function.
//
// GET  /api/publish-tests → returns the CURRENT tests array + commit sha, fetched
//                          server-side via the authenticated GitHub API (always fresh,
//                          bypasses the raw.githubusercontent CDN cache).
//
// POST /api/publish-tests → accepts a DELTA payload so concurrent editors never
//                          clobber each other:
//   { changedTests: [...], deletedIds: [...], author: "..." }
//   Server merges by ID into current data.json, commits, and returns the merged tests.

const REPO_OWNER = "juangarza918";
const REPO_NAME  = "Crescent-SAP-Transformation";
const FILE_PATH  = "data.json";
const API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`;
const ALLOWED_ORIGINS = [
  "https://crescent-sap-transformation.vercel.app",
  "http://localhost:8765",
];

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.send(JSON.stringify(body));
}

async function ghFetch(url, opts = {}) {
  const token = process.env.GITHUB_TOKEN;
  const headers = Object.assign(
    {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "crescent-sap-dashboard",
    },
    opts.headers || {}
  );
  return fetch(url, Object.assign({}, opts, { headers }));
}

async function fetchCurrent() {
  const getResp = await ghFetch(`${API}?ref=main`);
  if (!getResp.ok) {
    const txt = await getResp.text();
    throw new Error(`GET data.json failed (${getResp.status}): ${txt.slice(0, 200)}`);
  }
  const info = await getResp.json();
  const sha = info.sha;
  const doc = JSON.parse(Buffer.from(info.content, "base64").toString("utf8"));
  return { doc, sha };
}

async function fetchAndMerge(changedTests, deletedIds) {
  const { doc, sha } = await fetchCurrent();
  const currentTests = Array.isArray(doc.tests) ? doc.tests : [];
  const byId = new Map(currentTests.map((t) => [t.id, t]));
  (changedTests || []).forEach((ct) => { if (ct && ct.id) byId.set(ct.id, ct); });
  (deletedIds || []).forEach((id) => byId.delete(id));
  const mergedTests = Array.from(byId.values());
  doc.tests = mergedTests;
  return { doc, sha, tests: mergedTests };
}

async function commitMerged(merged, author, retriesLeft) {
  const putResp = await ghFetch(API, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Update tests via dashboard (${author})`,
      content: Buffer.from(JSON.stringify(merged.doc, null, 2)).toString("base64"),
      sha: merged.sha,
      branch: "main",
    }),
  });
  if (putResp.status === 409 && retriesLeft > 0) {
    const fresh = await fetchAndMerge(merged.changed, merged.deleted);
    fresh.changed = merged.changed; fresh.deleted = merged.deleted;
    return commitMerged(fresh, author, retriesLeft - 1);
  }
  if (!putResp.ok) {
    const txt = await putResp.text();
    throw new Error(`PUT data.json failed (${putResp.status}): ${txt.slice(0, 200)}`);
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

  // GET: return the freshest tests array (bypasses CDN cache)
  if (req.method === "GET") {
    try {
      const { doc, sha } = await fetchCurrent();
      const tests = Array.isArray(doc.tests) ? doc.tests : [];
      return json(res, 200, { tests, commit: sha, testsCount: tests.length });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  let changedTests, deletedIds;
  if (Array.isArray(body.changedTests) || Array.isArray(body.deletedIds)) {
    changedTests = Array.isArray(body.changedTests) ? body.changedTests : [];
    deletedIds   = Array.isArray(body.deletedIds)   ? body.deletedIds   : [];
    if (changedTests.length === 0 && deletedIds.length === 0) {
      return json(res, 200, { success: true, tests: null, noop: true });
    }
  } else if (Array.isArray(body.tests)) {
    // Backwards-compat (unsafe under concurrency, kept for old clients during rollout).
    changedTests = body.tests; deletedIds = [];
  } else {
    return json(res, 400, { error: "Body must include `changedTests`+`deletedIds` or legacy `tests`." });
  }

  if (changedTests.length > 5000) return json(res, 413, { error: "Too many tests in one save (>5000)." });

  const author = String(body.author || "anonymous")
    .replace(/[^\w\s.@-]/g, "").slice(0, 100) || "anonymous";

  try {
    const merged = await fetchAndMerge(changedTests, deletedIds);
    merged.changed = changedTests; merged.deleted = deletedIds;
    const result = await commitMerged(merged, author, 3);
    return json(res, 200, {
      success: true,
      commit: (result.commit || {}).sha,
      tests: merged.tests,
      testsCount: merged.tests.length,
    });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
};
