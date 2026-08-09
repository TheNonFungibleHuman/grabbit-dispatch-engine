export interface GeoCoords {
  lng: number;
  lat: number;
}

export interface GeocodeResult extends GeoCoords {
  label: string;
}

/**
 * Minimal Mauritius-biased geocoder via OpenStreetMap Nominatim.
 * Replace with a paid provider later if you need higher accuracy/SLA.
 */
export async function geocodeAddress(address: string): Promise<GeocodeResult> {
  const query = address.trim();
  if (!query) {
    throw new Error("Address is required for geocoding");
  }

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("countrycodes", "mu");
  url.searchParams.set("q", query);

  const response = await fetch(url, {
    headers: {
      "User-Agent": "grabbit-whatsapp-agent/1.0 (delivery booking)",
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Geocoder failed with status ${response.status}`);
  }

  const results = (await response.json()) as Array<{
    lat: string;
    lon: string;
    display_name?: string;
  }>;

  const first = results[0];
  if (!first) {
    throw new Error(`Could not geocode address: ${query}`);
  }

  const lat = Number(first.lat);
  const lng = Number(first.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`Geocoder returned invalid coords for: ${query}`);
  }
  if (lat === 0 && lng === 0) {
    throw new Error(`Geocoder returned placeholder coords for: ${query}`);
  }

  return {
    lat,
    lng,
    label: first.display_name ?? query,
  };
}
