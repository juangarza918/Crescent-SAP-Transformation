// POST /api/create-project
// Body: { name, icon?, color?, accent?, cloneFromId?, author? }
// Creates a new entry in data/projects.json AND a fresh data/<id>.json for it.
// New projects always start with status="active"; mark them completed later via settings.

const REPO_OWNER = "juangarza918";
const REPO_NAME  = "Crescent-SAP-Transformation";
const PROJECTS_PATH = "data/projects.json";
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
function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "project";
}
function blankDoc(name, today) {
  return {
    meta: {
      projectName: name,
      reportDate: today,
      overallStatus: "G",
      goLiveDate: "",
      goLiveLabel: "Production Go-Live",
      narrative: ""
    },
    workstreams: [], schedule: [], risks: [], decisions: [], tests: []
  };
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
  const name = String(body.name || "").trim();
  if (!name) return json(res, 400, { error: "Project `name` is required." });
  if (name.length > 100) return json(res, 400, { error: "Project `name` too long." });
  const icon = String(body.icon || "📊").slice(0, 8);
  const color = /^#[0-9a-f]{6}$/i.test(body.color || "") ? body.color : "#0f2545";
  const accent = /^#[0-9a-f]{6}$/i.test(body.accent || "") ? body.accent : "#c8a24b";
  const author = String(body.author || "anonymous").replace(/[^\w\s.@-]/g, "").slice(0, 80) || "anonymous";
  const cloneFromId = body.cloneFromId ? String(body.cloneFromId).replace(/[^a-z0-9._-]/gi, "").slice(0, 80) : null;
  const today = new Date().toISOString().slice(0, 10);

  try {
    const projectsFile = await getFile(PROJECTS_PATH);
    const projectsDoc = projectsFile.exists ? projectsFile.content : { projects: [] };
    const existing = new Set(projectsDoc.projects.map(p => p.id));
    let base = slugify(name);
    let id = base; let n = 2;
    while (existing.has(id)) { id = `${base}-${n++}`; }

    let newDoc;
    if (cloneFromId) {
      const srcFile = await getFile(`data/${cloneFromId}.json`);
      if (!srcFile.exists) return json(res, 400, { error: `Clone source not found: ${cloneFromId}` });
      newDoc = JSON.parse(JSON.stringify(srcFile.content));
      newDoc.meta = Object.assign({}, newDoc.meta || {}, {
        projectName: name, reportDate: today,
        narrative: `Cloned from "${srcFile.content.meta ? srcFile.content.meta.projectName : cloneFromId}" on ${today}.`
      });
    } else {
      newDoc = blankDoc(name, today);
    }
    const dataPath = `data/${id}.json`;
    const putDataResp = await putFile(dataPath, newDoc, `[${id}] Create new project "${name}" (${author})`);

    projectsDoc.projects.push({
      id, name, icon, color, accent,
      status: "active",
      created: today, dataFile: `${id}.json`, createdBy: author
    });
    await putFile(PROJECTS_PATH, projectsDoc, `Add project "${name}" to projects index (${author})`, projectsFile.sha);

    return json(res, 200, {
      success: true,
      project: { id, name, icon, color, accent, status: "active", created: today, dataFile: `${id}.json` },
      commit: (putDataResp.commit || {}).sha,
      testsCount: Array.isArray(newDoc.tests) ? newDoc.tests.length : 0
    });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
};
