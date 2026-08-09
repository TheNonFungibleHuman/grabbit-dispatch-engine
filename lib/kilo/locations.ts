import type { KiloServiceLocation, ServiceLocationUnit } from "./types";

/** Compose address the way the public Kilo form does. */
export function composeServiceLocationAddress(
  location: Pick<KiloServiceLocation, "name" | "address">,
  unit?: string | null,
): string {
  const parts = [location.name.trim(), location.address.trim()];
  if (unit?.trim()) {
    parts.push(unit.trim());
  }
  return parts.join(" — ");
}

export function expandUnitOptions(unit: ServiceLocationUnit): string[] {
  const fromRanges = unit.ranges.flatMap((range) => {
    const values: string[] = [];
    if (range.end < range.start) return values;
    const max = Math.min(range.end, range.start + 200);
    for (let i = range.start; i <= max; i += 1) {
      const number = String(i).padStart(Math.max(0, range.pad), "0");
      values.push(`${range.prefix}${number}${range.suffix}`);
    }
    return values;
  });
  return Array.from(new Set([...fromRanges, ...unit.values]));
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchServiceLocations(
  query: string,
  locations: KiloServiceLocation[],
  limit = 5,
): KiloServiceLocation[] {
  const needle = normalizeText(query);
  if (!needle || locations.length === 0) return [];

  const scored = locations
    .map((location) => {
      const name = normalizeText(location.name);
      const address = normalizeText(location.address);
      const haystack = `${name} ${address}`;
      let score = 0;
      if (name === needle) score += 100;
      if (name.includes(needle) || needle.includes(name)) score += 50;
      if (haystack.includes(needle)) score += 30;
      if (address.includes(needle)) score += 20;
      for (const token of needle.split(" ")) {
        if (token.length < 2) continue;
        if (name === token) score += 40;
        if (name.includes(token)) score += 12;
        if (address.includes(token)) score += 4;
        for (const nameToken of name.split(" ")) {
          if (nameToken.startsWith(token) || token.startsWith(nameToken)) {
            score += 8;
          }
        }
      }
      return { location, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((row) => row.location);
}

export function resolveUnitFollowUp(unit: ServiceLocationUnit): {
  status: "done" | "ask_free_text" | "ask_list";
  label: string;
  required: boolean;
  options?: string[];
  allowCustom?: boolean;
} {
  if (unit.mode === "none") {
    return { status: "done", label: unit.label, required: false };
  }
  if (unit.mode === "free_text") {
    return {
      status: "ask_free_text",
      label: unit.label,
      required: unit.required,
    };
  }
  return {
    status: "ask_list",
    label: unit.label,
    required: unit.required,
    options: expandUnitOptions(unit).slice(0, 40),
    allowCustom: unit.allowCustom,
  };
}
