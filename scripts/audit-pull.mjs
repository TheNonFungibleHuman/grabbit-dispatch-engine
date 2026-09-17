// One-off audit: dump all grabbit/* documents relevant to Sept 12 - today
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const url = process.env.SUPABASE_URL.replace(/\/+$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
const base = `${process.env.SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/grabbit_documents`;

async function listAll() {
  const rows = [];
  let offset = 0;
  while (true) {
    const res = await fetch(
      `${url}/rest/v1/grabbit_documents?select=pathname,updated_at,data&order=updated_at.desc&limit=1000&offset=${offset}`,
      { headers },
    );
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < 1000) break;
    offset += 1000;
  }
  return rows;
}

const rows = await listAll();
mkdirSync("audit-2026-09-17", { recursive: true });

const interesting = rows.filter((r) => r.pathname?.startsWith("grabbit/"));
for (const r of interesting) {
  const safe = r.pathname.replace(/[\\/]/g, "__");
  writeFileSync(`audit/${safe}.json`, JSON.stringify(r.data, null, 2));
}

// Print a manifest of what was captured
const sessions = interesting.filter((r) => r.pathname.includes("/sessions/") && r.pathname.endsWith("transcript.json"));
console.log(`total docs: ${interesting.length}, transcripts: ${sessions.length}`);
for (const s of sessions) {
  const t = s.data;
  const entries = t?.entries ?? [];
  const first = entries[0]?.at ?? "?";
  const last = entries.at(-1)?.at ?? "?";
  console.log(`${s.pathname} | updated=${s.updated_at} | entries=${entries.length} | first=${first} | last=${last}`);
}
