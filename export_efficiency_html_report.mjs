#!/usr/bin/env node
import fs from "node:fs/promises";

const pageId = "860877904";
const configPath = "/Users/hancwang/.vscode/mcp.json";
const outputPath = "outputs/aioe-intake-status-history/efficiency-portfolio-status-report.html";
const config = JSON.parse((await fs.readFile(configPath, "utf8")).replace(/,\s*([}\]])/g, "$1"));
const confluence = client(config.servers.confluence, "efficiency-html-report");
const jira = client(config.servers.jira, "efficiency-html-report-jira");
await Promise.all([confluence.init(), jira.init()]);

const page = await confluence.call("call_confluence_rest_api", {
  endpoint: `content/${pageId}`,
  method: "GET",
  params: { expand: "version,body.storage,title,type" }
});
const content = page.response?.result ? JSON.parse(page.response.result) : page;
const source = content.body.storage.value;
const rows = source.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) ?? [];
const primaryKeys = [...new Set(rows.slice(1).map(row => row.match(/<ac:parameter ac:name="key">(WBXPLTFM-\d+)<\/ac:parameter>/)?.[1]).filter(Boolean))];

const intakeIssues = new Map();
for (let i = 0; i < primaryKeys.length; i += 8) {
  const batch = primaryKeys.slice(i, i + 8);
  const results = await Promise.all(batch.map(async key => [key, await jira.call("call_jira_rest_api", {
    endpoint: `issue/${key}`,
    method: "GET",
    params: { fields: "summary,status,assignee,issuelinks" }
  })]));
  results.forEach(([key, issue]) => intakeIssues.set(key, issue));
}

const implementationKeys = [...new Set([...intakeIssues.values()].flatMap(issue =>
  (issue.fields?.issuelinks ?? []).filter(link => link.type?.name === "Implementation")
    .map(link => link.inwardIssue?.key).filter(Boolean)
))];
const implementations = new Map();
for (let i = 0; i < implementationKeys.length; i += 8) {
  const batch = implementationKeys.slice(i, i + 8);
  const results = await Promise.all(batch.map(async key => [key, await jira.call("call_jira_rest_api", {
    endpoint: `issue/${key}`, method: "GET",
    params: { fields: "summary,status,assignee" }
  })]));
  results.forEach(([key, issue]) => implementations.set(key, issue));
}

let table = source.slice(source.indexOf("<table"), source.indexOf("</table>") + 8);
let rowIndex = 0;
table = table.replace(/<tr\b[^>]*>[\s\S]*?<\/tr>/g, row => {
  if (rowIndex++ === 0) return row;
  const key = row.match(/<ac:parameter ac:name="key">(WBXPLTFM-\d+)<\/ac:parameter>/)?.[1];
  if (!key) return row;
  const cells = [...row.matchAll(/<td\b[^>]*>[\s\S]*?<\/td>/g)].map(m => m[0]);
  if (cells.length < 10) return row;
  const linked = (intakeIssues.get(key)?.fields?.issuelinks ?? [])
    .filter(link => link.type?.name === "Implementation")
    .map(link => implementations.get(link.inwardIssue?.key) ?? link.inwardIssue)
    .filter(Boolean);
  cells[9] = `<td>${linked.length ? linked.map(issue => {
    const assignee = issue.fields?.assignee?.displayName ?? "Unassigned";
    const status = issue.fields?.status?.name ?? "Unknown";
    return `<div class="implemented"><a href="https://jira-eng-gpk2.cisco.com/jira/browse/${issue.key}"><strong>${esc(issue.key)}</strong></a><br>${esc(issue.fields?.summary ?? "")}<br><span class="meta">${esc(status)} · ${esc(assignee)}</span></div>`;
  }).join("") : "<span class=\"none\">None</span>"}</td>`;
  let cellIndex = 0;
  return row.replace(/<td\b[^>]*>[\s\S]*?<\/td>/g, () => cells[cellIndex++]);
});

table = table.replace(/<ac:structured-macro(?:(?!<\/ac:structured-macro>)[\s\S])*?<ac:parameter ac:name="key">(WBXPLTFM-\d+)<\/ac:parameter>(?:(?!<\/ac:structured-macro>)[\s\S])*?<\/ac:structured-macro>/g,
  (_, key) => `<a href="https://jira-eng-gpk2.cisco.com/jira/browse/${key}">${key}</a>`);

const generatedAt = new Date().toISOString();
const implementationMap = Object.fromEntries(primaryKeys.map(key => [key,
  (intakeIssues.get(key)?.fields?.issuelinks ?? []).filter(link => link.type?.name === "Implementation")
    .map(link => link.inwardIssue?.key).filter(Boolean)
]));
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(content.title)}</title><style>
body{font-family:Arial,sans-serif;color:#172b4d;margin:24px;background:#f7f8fa}h1{font-size:24px;margin:0 0 6px}.stamp{color:#5e6c84;margin:0 0 18px}table{border-collapse:collapse;width:100%;background:#fff;font-size:12px}th,td{border:1px solid #dfe1e6;padding:8px;vertical-align:top}th{background:#f1f2f4;text-align:left;position:sticky;top:0}p{margin:0 0 6px}a{color:#0052cc;text-decoration:none}.implemented{margin-bottom:10px}.implemented:last-child{margin-bottom:0}.meta{color:#5e6c84}.none{color:#7a869a}
</style></head><body><h1>${esc(content.title)}</h1><p class="stamp">Generated from Confluence version ${content.version.number} and live Jira data at ${generatedAt}</p>${table}</body></html>`;

await fs.mkdir("outputs/aioe-intake-status-history", { recursive: true });
await fs.writeFile(outputPath, html);
console.log(JSON.stringify({ outputPath, confluenceVersion: content.version.number, intakeCount: primaryKeys.length, implementationCount: implementationKeys.length, renderedImplementationCount: (html.match(/class="implemented"/g) ?? []).length, implementationMap, generatedAt }, null, 2));

function esc(value) { return String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

function client(settings, name) {
  let id = 1, session = null;
  async function rpc(method, params={}) {
    const headers = { ...settings.headers, "Content-Type":"application/json", Accept:"application/json, text/event-stream" };
    if (session) headers["Mcp-Session-Id"] = session;
    const response = await fetch(settings.url, { method:"POST", headers, body:JSON.stringify({jsonrpc:"2.0",id:id++,method,params}) });
    session = response.headers.get("mcp-session-id") ?? session;
    const raw = await response.text();
    if (!response.ok) throw new Error(`${method} HTTP ${response.status}: ${raw.slice(0,500)}`);
    const data = raw.split("\n").filter(x=>x.startsWith("data:")).map(x=>x.slice(5).trim()).join("\n").trim() || raw.trim();
    const parsed = JSON.parse(data);
    if (parsed.error) throw new Error(JSON.stringify(parsed.error));
    return parsed.result;
  }
  return {
    async init() {
      await rpc("initialize",{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name,version:"1.0"}});
      const headers={...settings.headers,"Content-Type":"application/json",Accept:"application/json, text/event-stream"};
      if(session) headers["Mcp-Session-Id"]=session;
      await fetch(settings.url,{method:"POST",headers,body:JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized",params:{}})});
    },
    async call(tool,args) {
      const result=await rpc("tools/call",{name:tool,arguments:args});
      const text=result.content?.find(x=>x.type==="text")?.text;
      if(!text) throw new Error(`No text from ${tool}`);
      return JSON.parse(text);
    }
  };
}
