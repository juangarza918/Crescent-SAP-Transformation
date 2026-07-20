// Vercel serverless function: accepts POST { tests, author } and commits the new
// tests array back to data.json in the GitHub repo. Uses a server-side token
// (GITHUB_TOKEN env var) so viewers do NOT need their own PAT to update tests.
// Only the `tests` field of data.json is replaced — other fields are preserved,
// which also prevents concurrent editors from clobbering unrelated data.

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

async function commitTests(newTests, author, retriesLeft) {
  // 1. Get current data.json (for SHA + full document)
  const getResp = await ghFetch(`${API}?ref=main`);
  if (!getResp.ok) {
    const txt = await getResp.text();
    throw new Error(`GET data.json failed (${getResp.status}): ${txt.slice(0, 200)}`);
  }
  const info = await getResp.json();
  const sha = info.sha;
  const currentDoc = JSON.parse(Buffer.from(info.content, "base64").toString("utf8"));

  // 2. Replace ONLY the tests array
  currentDoc.tests = newTests;

  // 3. PUT new content
  const putResp = await ghFetch(API, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Update tests via dashboard (${author})`,
      content: Buffer.from(JSON.stringify(currentDoc, null, 2)).toString("base64"),
      sha,
      branch: "main",
    }),
  });
  if (putResp.status === 409 && retriesLeft > 0) {
    // Optimistic-lock conflict — someone else committed while we were fetching. Retry.
    return commitTests(newTests, author, retriesLeft - 1);
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
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  // Origin gate — allow only the deployed site and localhost dev
  if (origin && !ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
    return json(res, 403, { error: `Forbidden origin: ${origin}` });
  }

  if (!process.env.GITHUB_TOKEN) {
    return json(res, 500, { error: "Server is missing GITHUB_TOKEN env var. Ask the admin to add it in Vercel > Project > Settings > Environment Variables." });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const newTests = body.tests;
  if (!Array.isArray(newTests)) return json(res, 400, { error: "Body must include a `tests` array." });

  // Basic safety cap so a rogue client can't push a huge blob
  if (newTests.length > 5000) return json(res, 413, { error: "Too many tests (>5000)." });

  const author = String(body.author || "anonymous")
    .replace(/[^\w\s.@-]/g, "")
    .slice(0, 100) || "anonymous";

  try {
    const result = await commitTests(newTests, author, 2);
    return json(res, 200, {
      success: true,
      commit: (result.commit || {}).sha,
      testsCount: newTests.length,
    });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
};
