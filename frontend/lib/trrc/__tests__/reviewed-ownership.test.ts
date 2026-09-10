import {it,expect} from "vitest";
import {linkReviewedMineralPosition} from "../decision-layer/ownership";
import {payloadHash} from "../decision-layer/partner-input";
import {reviewedPositionFixture as fixture} from "./fixtures/reviewed-position";
const api="4216502733";

it("uses the existing graph to reproduce the sample exact NMA and NRI",()=>{const f=fixture();const r=linkReviewedMineralPosition(api,f.title,f.position);expect(r.status).toBe("calculated");expect(r.nri).toEqual({n:"3",d:"256"});if(r.status==="calculated")expect(r.netMineralAcres).toEqual({n:"40",d:"1"});});
it("does not infer an acquisition position from an API",()=>{expect(linkReviewedMineralPosition(api,null,null)).toMatchObject({reasonCode:"position_not_supplied"});});
it("requires a confirmed well/tract association",()=>{const f=fixture();f.title.wells[0].associations[0].reviewStatus="proposed";expect(linkReviewedMineralPosition(api,f.title,f.position).status).toBe("insufficient_data");});
it("never divides a collective holding",()=>{const f=fixture();f.holding.parties.push({...f.holding.parties[0],canonicalPartyId:"other"});expect(linkReviewedMineralPosition(api,f.title,f.position).nri).toBeNull();});
it("rejects ownership attached to another API",()=>{const f=fixture();f.position.api="4243934308";expect(()=>linkReviewedMineralPosition(api,f.title,f.position)).toThrow(/API mismatch/);});
it("rejects a stale selected title version",()=>{const f=fixture();f.position.analysisId="old";expect(()=>linkReviewedMineralPosition(api,f.title,f.position)).toThrow(/different title/);});
it("rejects modified evidence and contradictory allocation",()=>{const f=fixture();f.position.sources[0].data.participation.n="2";expect(()=>linkReviewedMineralPosition(api,f.title,f.position)).toThrow(/hash mismatch/);f.position.sources[0].sha256=payloadHash(f.position.sources[0].data);expect(()=>linkReviewedMineralPosition(api,f.title,f.position)).toThrow(/contradicts/);});
it("withholds an uncited holding",()=>{const f=fixture();f.title.branches[0].events[0].citations=[];expect(linkReviewedMineralPosition(api,f.title,f.position).nri).toBeNull();});
