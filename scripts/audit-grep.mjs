import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = "audit";
const files = readdirSync(dir).filter((f) => f.includes("__transcript.json.json"));
const re = /maintenance|pause|paused|temporarily|closed|downtime|shut down|shutdown|not (?:taking|accepting) (?:orders|bookings)|offline/i;
const windowStart = Date.parse("2026-09-12T00:00:00Z");

for (const f of files) {
  const j = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
  for (const e of j.entries ?? []) {
    if (!e.text || !re.test(e.text)) continue;
    const at = Date.parse(e.at);
    if (at < windowStart) continue;
    console.log(`\n### ${f.replace("grabbit__sessions__", "").replace("__transcript.json.json", "")} ${e.at} [${e.role}]`);
    console.log(String(e.text).slice(0, 500));
  }
}
