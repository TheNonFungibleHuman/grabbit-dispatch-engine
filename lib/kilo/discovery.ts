import {
  getCapabilities,
  listServiceLocations,
  listWarehouses,
} from "./client.ts";
import {
  composeServiceLocationAddress,
  expandUnitOptions,
  matchServiceLocations,
  resolveUnitFollowUp,
} from "./locations.ts";
import type {
  KiloCapabilities,
  KiloServiceLocation,
  KiloWarehouse,
} from "./types.ts";
import { formatError, logInfo, logWarn } from "../log.ts";

export {
  composeServiceLocationAddress,
  expandUnitOptions,
  matchServiceLocations,
  resolveUnitFollowUp,
};

const CACHE_TTL_MS = 5 * 60 * 1000;

interface DiscoveryBundle {
  fetchedAt: number;
  capabilities: KiloCapabilities;
  warehouses: KiloWarehouse[];
  serviceLocations: KiloServiceLocation[];
}

let orgCache: DiscoveryBundle | null = null;

export async function getDiscoveryBundle(
  force = false,
): Promise<DiscoveryBundle> {
  if (!force && orgCache && Date.now() - orgCache.fetchedAt < CACHE_TTL_MS) {
    logInfo("kilo", "discovery cache hit", {
      ageMs: Date.now() - orgCache.fetchedAt,
      serviceLocations: orgCache.serviceLocations.length,
      warehouses: orgCache.warehouses.length,
    });
    return orgCache;
  }

  logInfo("kilo", "discovery fetch start", { force });

  const [capabilitiesRes, warehousesRes, locationsRes] = await Promise.all([
    getCapabilities(),
    listWarehouses()
      .then((res) => ({
        ok: true as const,
        warehouses: res.warehouses ?? [],
      }))
      .catch((error) => {
        logWarn("kilo", "warehouses fetch failed", formatError(error));
        return { ok: false as const, warehouses: [] as KiloWarehouse[] };
      }),
    listServiceLocations()
      .then((res) => ({
        ok: true as const,
        serviceLocations: res.serviceLocations ?? [],
      }))
      .catch((error) => {
        logWarn("kilo", "service-locations fetch failed", formatError(error));
        return {
          ok: false as const,
          serviceLocations: [] as KiloServiceLocation[],
        };
      }),
  ]);

  orgCache = {
    fetchedAt: Date.now(),
    capabilities: capabilitiesRes.capabilities,
    warehouses: warehousesRes.warehouses,
    serviceLocations: locationsRes.serviceLocations,
  };

  logInfo("kilo", "discovery fetch done", {
    org: orgCache.capabilities.organization.name,
    serviceKinds: orgCache.capabilities.enabledServiceKinds,
    warehouses: orgCache.warehouses.length,
    warehousesOk: warehousesRes.ok,
    serviceLocations: orgCache.serviceLocations.length,
    locationsOk: locationsRes.ok,
    locationNames: orgCache.serviceLocations.slice(0, 30).map((l) => l.name),
  });

  return orgCache;
}

export function pickCollectionMethod(
  capabilities: KiloCapabilities,
): "cash_on_delivery" | "online_checkout" {
  const preferred = process.env.KILO_COLLECTION_METHOD?.trim();
  if (
    preferred === "online_checkout" &&
    capabilities.paymentCollection.onlineCheckout
  ) {
    return "online_checkout";
  }
  if (capabilities.paymentCollection.cashOnDelivery) {
    return "cash_on_delivery";
  }
  if (capabilities.paymentCollection.onlineCheckout) {
    return "online_checkout";
  }
  throw new Error("No payment collection methods enabled for this Kilo org");
}

export function summarizeDiscoveryForAgent(bundle: DiscoveryBundle): string {
  const caps = bundle.capabilities;
  const kinds = caps.enabledServiceKinds.join(", ") || "none";
  const payments: string[] = [];
  if (caps.paymentCollection.cashOnDelivery) payments.push("cash_on_delivery");
  if (caps.paymentCollection.onlineCheckout) payments.push("online_checkout");

  const locations = bundle.serviceLocations
    .slice(0, 40)
    .map((loc) => {
      const unitHint =
        loc.unit.mode === "none"
          ? "unit:none"
          : `unit:${loc.unit.mode}(${loc.unit.label}${loc.unit.required ? ",required" : ""})`;
      return `• ${loc.name} [${loc.id}] (${loc.category}, ${unitHint})`;
    })
    .join("\n");

  const warehouses = bundle.warehouses
    .map((w) => `• ${w.name} [${w.id}] - ${w.address}`)
    .join("\n");

  return [
    "[kilo discovery]",
    `org: ${caps.organization.name}`,
    `enabledServiceKinds: ${kinds}`,
    `defaultServiceKind: ${caps.defaultServiceKind}`,
    `allowWarehouseDropoff: ${caps.allowWarehouseDropoff}`,
    `paymentCollection: ${payments.join(", ") || "none"}`,
    `pod.enabled: ${caps.pod.enabled}`,
    `features.serviceLocations: ${caps.features.serviceLocations}`,
    `errand.modes: ${caps.errand.enabledModes.join(", ") || "n/a"}`,
    caps.errand.curatedLinks.length
      ? `errand.curatedLinks: ${caps.errand.curatedLinks
          .slice(0, 10)
          .map((l) => `${l.name}<${l.url}>`)
          .join("; ")}`
      : "errand.curatedLinks: none",
    warehouses ? `warehouses:\n${warehouses}` : "warehouses: none",
    locations ? `serviceLocations:\n${locations}` : "serviceLocations: none",
    "For pickup_delivery known places, match serviceLocations then follow unit mode. For errand shop side, do NOT use service locations; use errand modes. Dropoff may still be a service location.",
  ].join("\n");
}
