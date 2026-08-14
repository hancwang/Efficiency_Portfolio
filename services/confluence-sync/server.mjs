#!/usr/bin/env node
import http from "node:http";

const port = Number(process.env.PORT || 8787);
const pageId = process.env.CONFLUENCE_PAGE_ID || "860877904";
const baseUrl = String(process.env.CONFLUENCE_BASE_URL || "").replace(/\/$/, "");
const token = process.env.CONFLUENCE_TOKEN || "";
const allowedOrigins = new Set(String(process.env.ALLOWED_ORIGINS || "https://hancwang.github.io").split(",").map(value => value.trim()).filter(Boolean));
const trustedIdentityHeader = String(process.env.TRUSTED_IDENTITY_HEADER || "x-authenticated-user").toLowerCase();

if (!baseUrl || !token) {
  console.error("CONFLUENCE_BASE_URL and CONFLUENCE_TOKEN are required.");
  process.exit(1);
}

http.createServer(async (request, response) => {
  const origin = request.headers.origin || "";
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Requested-With");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Content-Type", "application/json; charset=utf-8");

  if (request.method === "OPTIONS") return response.end();
  if (request.method === "GET" && request.url === "/health") return json(response, 200, { ok: true, pageId });
  if (request.method !== "POST" || request.url !== "/api/sync-next-step") return json(response, 404, { error: "Not found" });
  if (!allowedOrigins.has(origin)) return json(response, 403, { error: "Origin not allowed" });

  const authenticatedUser = request.headers[trustedIdentityHeader];
  if (!authenticatedUser) return json(response, 401, { error: "Authenticated corporate identity required" });

  try {
    const body = await readJson(request);
    const jiraKey = String(body.jiraKey || "").trim().toUpperCase();
    const nextStep = String(body.nextStep || "").trim();
    if (!/^WBXPLTFM-\d+$/.test(jiraKey)) return json(response, 400, { error: "Invalid Jira key" });
    if (!nextStep || nextStep.length > 8000) return json(response, 400, { error: "Next Step must contain 1-8000 characters" });

    const result = await updateNextStep(jiraKey, nextStep, String(authenticatedUser));
    return json(response, 200, result);
  } catch (error) {
    console.error(error);
    return json(response, error.status || 500, { error: error.message || "Sync failed" });
  }
}).listen(port, () => console.log(`Confluence sync service listening on ${port}`));

async function updateNextStep(jiraKey, nextStep, user) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const page = await confluence(`content/${pageId}?expand=version,body.storage,title,type`, { method: "GET" });
    const source = page.body?.storage?.value;
    if (!source) throw httpError(502, "Confluence page did not return storage content");
    const updated = replaceNextStep(source, jiraKey, nextStep);
    if (updated === source) throw httpError(404, `${jiraKey} was not found in the tracker table`);
    try {
      const saved = await confluence(`content/${pageId}`, {
        method: "PUT",
        body: JSON.stringify({
          id: pageId,
          type: page.type,
          title: page.title,
          version: { number: page.version.number + 1, message: `Next Step updated for ${jiraKey} by ${user}` },
          body: { storage: { value: updated, representation: "storage" } }
        })
      });
      return { ok: true, jiraKey, pageId, confluenceVersion: saved.version?.number, updatedBy: user, updatedAt: new Date().toISOString() };
    } catch (error) {
      if (error.status !== 409 || attempt === 1) throw error;
    }
  }
}

function replaceNextStep(source, jiraKey, nextStep) {
  let found = false;
  return source.replace(/<tr\b[^>]*>[\s\S]*?<\/tr>/g, row => {
    if (!row.includes(jiraKey)) return row;
    const cells = [...row.matchAll(/<td\b[^>]*>[\s\S]*?<\/td>/g)].map(match => match[0]);
    if (cells.length < 4) throw httpError(422, `Tracker row for ${jiraKey} does not contain a Next Step column`);
    const markerTags = [...cells[3].matchAll(/<\/?ac:inline-comment-marker\b[^>]*>/g)].map(match => match[0]).join("");
    cells[3] = `<td>${markerTags}<p>${escapeHtml(nextStep).replace(/\r?\n/g, "<br />")}</p></td>`;
    let index = 0;
    found = true;
    return row.replace(/<td\b[^>]*>[\s\S]*?<\/td>/g, () => cells[index++]);
  }).replace(/$/, () => {
    if (!found) return "";
    return "";
  });
}

async function confluence(endpoint, init) {
  const response = await fetch(`${baseUrl}/rest/api/${endpoint}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json", ...(init.headers || {}) }
  });
  const text = await response.text();
  if (!response.ok) throw httpError(response.status, `Confluence ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 20000) throw httpError(413, "Request too large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw httpError(400, "Invalid JSON"); }
}

function escapeHtml(value) { return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function json(response, status, body) { response.statusCode = status; response.end(JSON.stringify(body)); }
function httpError(status, message) { const error = new Error(message); error.status = status; return error; }

export { replaceNextStep };
