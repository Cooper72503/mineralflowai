import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
import {confirmedOpenCount,selectExactOperator} from "../browser-contracts.js";
const f=vi.hoisted(()=>{
 const state={visible:true,body:"",html:"",options:[{value:"123456",text:"123456 ACME OIL, INC."}]};
 const locator:any={first:()=>locator,nth:()=>locator,isVisible:vi.fn(async()=>state.visible),waitFor:vi.fn(async()=>{if(!state.visible)throw Error("hidden");}),fill:vi.fn(),click:vi.fn(),all:vi.fn(async()=>[]),allTextContents:vi.fn(async()=>[]),selectOption:vi.fn(),evaluateAll:vi.fn(async()=>state.options)};
 const page={locator:vi.fn(()=>locator),goto:vi.fn(),waitForLoadState:vi.fn(),waitForSelector:vi.fn(async()=>null),waitForFunction:vi.fn(async()=>null),innerText:vi.fn(async()=>state.body),content:vi.fn(async()=>state.html),setDefaultTimeout:vi.fn(),click:vi.fn(),fill:vi.fn(),selectOption:vi.fn(),waitForTimeout:vi.fn()};
 const context={newPage:async()=>page,close:vi.fn()};
 const browser={isConnected:()=>true,newContext:async()=>context,close:vi.fn()};
 return {state,locator,page,context,browser,launch:vi.fn(async()=>browser)};
});
vi.mock("playwright",()=>({chromium:{launch:f.launch}}));
import {getComplianceViolations,getInactiveWellStatus,closeBrowser} from "../browser.js";
beforeEach(()=>{vi.clearAllMocks();f.state.visible=true;f.state.body="";f.state.html="";});
afterEach(async()=>{await closeBrowser();});
describe("browser retrieval cannot treat an unexecuted or unparsed query as clean",()=>{
 it("fails when compliance form controls are missing",async()=>{
  f.state.visible=false;
  const result=await getComplianceViolations(null,"4216502733");
  expect(result.error).toMatch(/no query was submitted/);
  expect(result.open_count).toBeNull();
  expect(f.locator.click).not.toHaveBeenCalled();
 });
 it("fails on a blank response after submission",async()=>{
  const result=await getComplianceViolations(null,"4216502733");
  expect(result.error).toMatch(/neither recognized/);
  expect(result.open_count).toBeNull();
 });
 it("accepts an explicit empty result only after submitting the 8-digit API",async()=>{
  f.state.body="Showing 0-0 out of 0 violations Your search returned no results";
  const result=await getComplianceViolations(null,"16502733");
  expect(result.error).toBeUndefined();
  expect(result.open_count).toBe(0);
  expect(f.locator.fill).toHaveBeenCalledWith("16502733");
 });
 it("does not accept the pre-search counter as an empty result",async()=>{
  f.state.body="Showing 0-0 out of 0 violations";
  expect((await getComplianceViolations(null,"16502733")).error).toMatch(/neither recognized/);
 });
 it("fails when violations are reported but no rows can be read",async()=>{
  f.state.body="Showing 1-10 out of 43 violations";
  expect((await getComplianceViolations("486710",null)).error).toMatch(/no rows could be read/);
 });
 it("rejects a query error even if the page also contains an empty-results message",async()=>{
  f.state.body="Ewa_1011 correct the errors. No results found";
  expect((await getComplianceViolations("123456",null)).error).toMatch(/rejected/);
 });
 it("rejects missing identity before launching the browser",async()=>{
  expect((await getComplianceViolations(null,null)).error).toMatch(/valid API/);
  expect(f.launch).not.toHaveBeenCalled();
 });
 it("does not turn a shut-in date into a plugging deadline",async()=>{
  f.state.html='<table class="DataGrid"><tr><th>API No.</th><th>Shut-in Date</th></tr><tr><td>16502733</td><td>01/01/2024</td></tr></table>';
  const result=await getInactiveWellStatus("4216502733","123456");
  expect(result.error).toBeUndefined();
  expect(result.is_inactive).toBe(true);
  expect(result.records[0].shut_in_date).toBe("01/01/2024");
  expect(result.plugging_deadline).toBeNull();
 });
 it("rejects inactive records for a different API",async()=>{
  f.state.html='<table class="DataGrid"><tr><th>API No.</th><th>Shut-in Date</th></tr><tr><td>16509999</td><td>01/01/2024</td></tr></table>';
  expect((await getInactiveWellStatus("4216502733","123456")).error).toMatch(/do not match/);
 });
});
describe("registry and compliance identity contracts",()=>{
 const options=[{value:"111111",text:"111111 ACME EXPLORATION"},{value:"123456",text:"123456 ACME OIL, INC."}];
 it("resolves an exact normalized name, not the first prefix match",()=>{
  expect(selectExactOperator(options,"Acme Oil Inc",null)).toBe("123456");
  expect(()=>selectExactOperator(options,"Acme",null)).toThrow(/unverified/);
 });
 it("requires a unique number match",()=>{
  expect(selectExactOperator(options,null,"123456")).toBe("123456");
  expect(()=>selectExactOperator([...options,options[1]],null,"123456")).toThrow(/ambiguous/);
 });
 it("keeps unknown compliance status unknown",()=>{
  expect(confirmedOpenCount([{compliant_on_reinspection:"",last_enforcement_action:"Notice issued"}])).toBeNull();
  expect(confirmedOpenCount([{compliant_on_reinspection:"N",last_enforcement_action:"Unresolved"},{compliant_on_reinspection:"Y",last_enforcement_action:""}])).toBe(1);
 });
});
