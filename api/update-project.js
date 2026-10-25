// POST /api/update-project
// Body: { projectId, indexUpdates: {name?, icon?, color?, accent?, status?}, metaUpdates: {...}, author? }
// `status` on the index is "active" | "completed" — determines which hub tab the project appears in.

const REPO_OWNER = "juangarza918";
const REPO_NAME  = "Crescent-SAP-Transformation";
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
  const headers = Object.assign({
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "crescent-sap-dashboard",
  }, opts.headers || {});
  return fetch(url, Object.assign({}, opts, { headers }));
}
async function getFile(path) {
  const r = await ghFetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}?ref=main`);
  if (r.status === 404) return { exists: false };
  if (!r.ok) throw new Error(`GET ${path} failed (${r.status})`);
  const info = await r.json();
  return { exists: true, sha: info.sha, content: JSON.parse(Buffer.from(info.content, "base64").toString("utf8")) };
}
async function putFile(path, obj, message, sha) {
  const payload = { message, content: Buffer.from(JSON.stringify(obj, null, 2)).toString("base64"), branch: "main" };
  if (sha) payload.sha = sha;
  const r = await ghFetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  if (!r.ok) { const txt = await r.text(); throw new Error(`PUT ${path} failed (${r.status}): ${txt.slice(0, 200)}`); }
  return r.json();
}

module.exports = async (req, res) => {
  const origin = req.headers.origin || "";
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  if (origin && !ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
    return json(res, 403, { error: `Forbidden origin: ${origin}` });
  }
  if (!process.env.GITHUB_TOKEN) return json(res, 500, { error: "Server is missing GITHUB_TOKEN env var." });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const projectId = String(body.projectId || "").replace(/[^a-z0-9._-]/gi, "").slice(0, 80);
  if (!projectId) return json(res, 400, { error: "projectId is required" });
  const indexUpdates = body.indexUpdates || {};
  const metaUpdates = body.metaUpdates || {};
  const author = String(body.author || "anonymous").replace(/[^\w\s.@-]/g, "").slice(0, 80) || "anonymous";

  const allowedIndex = ["name","icon","color","accent","status"];
  const allowedMeta  = ["projectName","overallStatus","reportDate","goLiveDate","goLiveLabel","narrative"];
  const safeIndex = {};
  allowedIndex.forEach(k => {
    if (indexUpdates[k] === undefined) return;
    if (k === "status") {
      const v = String(indexUpdates[k]).toLowerCase();
      safeIndex[k] = (v === "completed") ? "completed" : "active";
    } else {
      safeIndex[k] = String(indexUpdates[k]).slice(0, 200);
    }
  });
  const safeMeta = {};
  allowedMeta.forEach(k => {
    if (metaUpdates[k] === undefined) return;
    safeMeta[k] = typeof metaUpdates[k] === "string" ? metaUpdates[k].slice(0, 5000) : metaUpdates[k];
  });

  try {
    const idxFile = await getFile("data/projects.json");
    if (!idxFile.exists) return json(res, 404, { error: "projects.json missing" });
    const idxDoc = idxFile.content;
    const entry = (idxDoc.projects || []).find(p => p.id === projectId);
    if (!entry) return json(res, 404, { error: `Project not found in index: ${projectId}` });
    Object.assign(entry, safeIndex);
    await putFile("data/projects.json", idxDoc, `[${projectId}] Update project index (${author})`, idxFile.sha);

    if (Object.keys(safeMeta).length > 0) {
      const docFile = await getFile(`data/${projectId}.json`);
      if (!docFile.exists) return json(res, 404, { error: `data/${projectId}.json missing` });
      const doc = docFile.content;
      doc.meta = Object.assign({}, doc.meta || {}, safeMeta);
      await putFile(`data/${projectId}.json`, doc, `[${projectId}] Update project meta (${author})`, docFile.sha);
    }

    return json(res, 200, { success: true, projectId, applied: { indexUpdates: safeIndex, metaUpdates: safeMeta } });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
};
