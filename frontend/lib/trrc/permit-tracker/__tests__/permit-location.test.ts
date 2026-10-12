import { describe, expect, it } from "vitest";
import { detailPathFor, parsePermitLocation, univDocNoFromDetailUrl } from "../permit-location";

// Trimmed from the live detail page for 42-163-34432 (Frio County), 2026-10-12.
const DETAIL = `<html><body><table>
<tr><td><p><span class="SubTitle"><b>Surface Location Information:</b></span></p>
<table class="DataGrid">
<tr><th>API #</th><th>Distance from<br> Nearest Town</th><th>Direction from<br> Nearest Town</th><th>Nearest Town</th><th>Surface Location Type</th></tr>
<tr><td> 163-34432 &nbsp; <a href="https://gis.rrc.texas.gov/GISViewer/index.html?api=16334432"><img alt="x"></a></td>
<td>11.0&nbsp; miles</td><td>SW</td><td>PEARSALL</td><td> Land </td></tr>
</table>
<TABLE class="GroupBox1">
<TR><TD><b>GPS Coordinates - Datum:&nbsp;</b>NAD 27&nbsp;</TD></TR>
<TR><TD><b>Latitude:&nbsp;</b>28.861858&nbsp; <b>Longitude:&nbsp;</b>-99.274169&nbsp;</TD></TR>
</TABLE></td></tr></table></body></html>`;

describe("parsePermitLocation", () => {
  it("reads the filed coordinates, datum and directions", () => {
    expect(parsePermitLocation(DETAIL)).toEqual({
      latitude: 28.861858,
      longitude: -99.274169,
      datum: "NAD 27",
      directions: "11.0 miles SW of PEARSALL",
    });
  });

  it("converts coordinates filed as degrees, minutes and seconds", () => {
    // As filed for 42-163-34437 (Frio County).
    const dms = DETAIL.replace(
      /<b>Latitude:[\s\S]*?-99\.274169&nbsp;/,
      "<b>Latitude Degrees:&nbsp;</b>28 <b>Latitude Minutes:&nbsp;</b>51 <b>Latitude Seconds:&nbsp;</b>09.75 " +
        "<b>Longitude Degrees:&nbsp;</b>-98 <b>Longitude Minutes:&nbsp;</b>54 <b>Longitude Seconds:&nbsp;</b>42.68",
    );
    const loc = parsePermitLocation(dms);
    expect(loc?.latitude).toBeCloseTo(28.852708, 6);
    expect(loc?.longitude).toBeCloseTo(-98.911856, 6);
    expect(loc?.datum).toBe("NAD 27");
  });

  // Expected values agree with TRRC GIS surface locations: exactly for NAD 83,
  // and within the ~45 m NAD 27 datum shift for NAD 27 (checked 2026-10-12).
  const statePlane = (datum: string, x: string, y: string, zone: string) =>
    DETAIL.replace(
      /<TABLE class="GroupBox1">[\s\S]*?<\/TABLE>/,
      `<TABLE class="GroupBox1"><TR><TD><b>GPS Coordinates - Datum:&nbsp;</b>${datum}&nbsp;</TD></TR>` +
        `<TR><TD><b>X =&nbsp;</b>${x} <b>Y =&nbsp;</b>${y}</TD></TR><TR><TD><b>State Plane Zone:&nbsp;</b>${zone}</TD></TR></TABLE>`,
    );

  it("converts NAD 83 State Plane feet (Karnes, South Central zone)", () => {
    const loc = parsePermitLocation(statePlane("NAD 83", "2314145", "13535698", "South Central"));
    expect(loc?.latitude).toBeCloseTo(28.963039, 5);
    expect(loc?.longitude).toBeCloseTo(-97.919025, 5);
    expect(loc?.datum).toBe("NAD 83");
  });

  it("converts NAD 27 State Plane feet (Midland, Central zone)", () => {
    const loc = parsePermitLocation(statePlane("NAD 27", "1504885.08", "765741.24", "Central"));
    expect(loc?.latitude).toBeCloseTo(31.762354, 5);
    expect(loc?.longitude).toBeCloseTo(-101.926368, 5);
  });

  it("returns null when the permit states no coordinates", () => {
    expect(parsePermitLocation(DETAIL.replace(/<TABLE class="GroupBox1">[\s\S]*?<\/TABLE>/, ""))).toBeNull();
  });

  it("rejects coordinates outside Texas instead of mapping them", () => {
    expect(parsePermitLocation(DETAIL.replace("-99.274169", "99.274169"))).toBeNull();
  });
});

describe("permit document numbers", () => {
  it("come from the detail link and build a fixed-host path", () => {
    const url = "https://webapps.rrc.state.tx.us/DP/drillDownQueryAction.do?name=OPPENHEIMER%2BA&fromPublicQuery=Y&univDocNo=499323637";
    expect(univDocNoFromDetailUrl(url)).toBe("499323637");
    expect(detailPathFor("499323637")).toBe("/DP/drillDownQueryAction.do?univDocNo=499323637&fromPublicQuery=Y");
  });

  it("reject anything that is not a plain number", () => {
    expect(univDocNoFromDetailUrl("https://webapps.rrc.state.tx.us/DP/x.do?univDocNo=1%26a%3Db")).toBeNull();
    expect(() => detailPathFor("../../etc")).toThrow();
  });
});
