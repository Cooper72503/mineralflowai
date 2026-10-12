import * as cheerio from "cheerio";
import proj4 from "proj4";

export interface PermitLocation {
  latitude: number;
  longitude: number;
  /** The datum as filed, e.g. "NAD 27". Coordinates are not shifted to another datum. */
  datum: string | null;
  /** e.g. "11.0 miles SW of PEARSALL", from the Surface Location table. */
  directions: string | null;
}

/** RRC's universal document number for a permit, from its detail-page link. */
export function univDocNoFromDetailUrl(detailUrl: string | null): string | null {
  if (!detailUrl) return null;
  try {
    const docNo = new URL(detailUrl).searchParams.get("univDocNo");
    return docNo && /^\d{1,12}$/.test(docNo) ? docNo : null;
  } catch {
    return null;
  }
}

/** Detail-page path for a permit. The host is fixed by RrcSession, never by the caller. */
export function detailPathFor(univDocNo: string): string {
  if (!/^\d{1,12}$/.test(univDocNo)) throw new Error("Invalid permit document number.");
  return `/DP/drillDownQueryAction.do?univDocNo=${univDocNo}&fromPublicQuery=Y`;
}

/**
 * Surface-location coordinates from a W-1 permit detail page. The page
 * states them as "GPS Coordinates - Datum: NAD 27 / Latitude: 28.861858
 * Longitude: -99.274169" (verified live against webapps.rrc.state.tx.us
 * on 2026-10-12). Filers may instead give degrees/minutes/seconds, or Texas
 * State Plane X/Y feet with a zone; both are converted to decimal degrees
 * in the filed datum. Returns null when the permit states no coordinates or
 * they fall outside Texas, rather than guessing.
 */
export function parsePermitLocation(html: string): PermitLocation | null {
  const $ = cheerio.load(html);
  const text = $("body").text().replace(/\u00a0/g, " ").replace(/\s+/g, " ");

  let latitude: number;
  let longitude: number;
  const decimal = text.match(/Latitude:\s*(-?\d{1,3}\.\d+)\s*Longitude:\s*(-?\d{1,3}\.\d+)/);
  // Some filers state degrees/minutes/seconds instead: "Latitude Degrees: 28
  // Latitude Minutes: 51 Latitude Seconds: 09.75 Longitude Degrees: -98 …".
  const dms = text.match(
    /Latitude Degrees:\s*(-?\d{1,3})\s*Latitude Minutes:\s*(\d{1,2})\s*Latitude Seconds:\s*(\d{1,2}(?:\.\d+)?)\s*Longitude Degrees:\s*(-?\d{1,3})\s*Longitude Minutes:\s*(\d{1,2})\s*Longitude Seconds:\s*(\d{1,2}(?:\.\d+)?)/,
  );
  if (decimal) {
    latitude = Number(decimal[1]);
    longitude = Number(decimal[2]);
  } else if (dms) {
    const toDecimal = (deg: string, min: string, sec: string) =>
      Math.sign(Number(deg) || 1) * (Math.abs(Number(deg)) + Number(min) / 60 + Number(sec) / 3600);
    latitude = Number(toDecimal(dms[1], dms[2], dms[3]).toFixed(6));
    // Every Texas longitude is west; some filers drop the minus sign.
    longitude = -Math.abs(Number(toDecimal(dms[4], dms[5], dms[6]).toFixed(6)));
  } else {
    const plane = statePlaneToLatLon(text);
    if (!plane) return null;
    [latitude, longitude] = plane;
  }
  // Texas spans roughly 25.8–36.5 N and 93.5–106.7 W.
  if (!(latitude > 25 && latitude < 37 && longitude < -93 && longitude > -107)) return null;

  const datum = text.match(/Datum:\s*([A-Z]{2,5}\s?\d{2})/)?.[1] ?? null;

  let directions: string | null = null;
  const townHeader = $("th").filter((_, el) => $(el).text().replace(/\s+/g, " ").trim() === "Nearest Town").first();
  const cells = townHeader.closest("tr").next("tr").find("td")
    .map((_, td) => $(td).text().replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim()).get();
  if (cells.length >= 4) {
    const [, distance, direction, town] = cells;
    if (distance && town) directions = `${distance}${direction ? ` ${direction}` : ""} of ${town}`;
  }

  return { latitude, longitude, datum, directions };
}

// Texas State Plane zones (Lambert conformal conic): standard parallels,
// origin latitude and central meridian, shared by NAD 27 and NAD 83.
const TX_ZONES: Record<string, { lat1: number; lat2: number; lat0: number; lon0: number; nad83: [number, number] }> = {
  "NORTH":         { lat1: 36 + 11 / 60, lat2: 34 + 39 / 60, lat0: 34,           lon0: -101.5,       nad83: [200000, 1000000] },
  "NORTH CENTRAL": { lat1: 33 + 58 / 60, lat2: 32 + 8 / 60,  lat0: 31 + 40 / 60, lon0: -98.5,        nad83: [600000, 2000000] },
  "CENTRAL":       { lat1: 31 + 53 / 60, lat2: 30 + 7 / 60,  lat0: 29 + 40 / 60, lon0: -100 - 1 / 3, nad83: [700000, 3000000] },
  "SOUTH CENTRAL": { lat1: 30 + 17 / 60, lat2: 28 + 23 / 60, lat0: 27 + 50 / 60, lon0: -99,          nad83: [600000, 4000000] },
  "SOUTH":         { lat1: 27 + 50 / 60, lat2: 26 + 10 / 60, lat0: 25 + 40 / 60, lon0: -98.5,        nad83: [300000, 5000000] },
};
const US_SURVEY_FOOT_M = 1200 / 3937;

/**
 * "GPS Coordinates - Datum: NAD 27 X = 1504885.08 Y = 765741.24 State Plane
 * Zone: Central" -> [lat, lon] in the filed datum. NAD 27 zones use a false
 * easting of 2,000,000 ft on Clarke 1866; NAD 83 zones use their metric
 * false origins on GRS 80. Coordinates are read as US survey feet, as filed;
 * a result outside Texas is rejected by the caller.
 */
function statePlaneToLatLon(text: string): [number, number] | null {
  const m = text.match(/Datum:\s*NAD\s?(27|83)\s*X\s*=\s*(-?\d+(?:\.\d+)?)\s*Y\s*=\s*(-?\d+(?:\.\d+)?)\s*State Plane Zone:\s*(North Central|South Central|North|Central|South)\b/i);
  if (!m) return null;
  const zone = TX_ZONES[m[4].toUpperCase()];
  const [x0, y0] = m[1] === "27" ? [2000000 * US_SURVEY_FOOT_M, 0] : zone.nad83;
  const ellps = m[1] === "27" ? "clrk66" : "GRS80";
  const def = `+proj=lcc +lat_1=${zone.lat1} +lat_2=${zone.lat2} +lat_0=${zone.lat0} +lon_0=${zone.lon0} +x_0=${x0} +y_0=${y0} +ellps=${ellps} +units=us-ft +no_defs`;
  const [lon, lat] = proj4(def, "+proj=longlat +ellps=" + ellps + " +no_defs", [Number(m[2]), Number(m[3])]);
  return Number.isFinite(lat) && Number.isFinite(lon) ? [Number(lat.toFixed(6)), Number(lon.toFixed(6))] : null;
}
