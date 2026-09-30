import {describe,it,expect,vi,beforeEach} from "vitest";
import {extractDocumentText,MAX_OCR_PAGES} from "../document-text";
const f=vi.hoisted(()=>({parse:vi.fn(),getDocument:vi.fn(),createWorker:vi.fn()}));
vi.mock("pdf-parse/lib/pdf-parse.js",()=>({default:f.parse}));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs",()=>({getDocument:f.getDocument}));
vi.mock("@napi-rs/canvas",()=>({createCanvas:()=>({getContext:()=>({}),toBuffer:()=>Buffer.from("image")})}));
vi.mock("tesseract.js",()=>({createWorker:f.createWorker}));
beforeEach(()=>vi.clearAllMocks());
describe("whole-document text coverage",()=>{
 it("rejects documents above the OCR page bound without partial success",async()=>{
  f.parse.mockResolvedValue({text:"",numpages:26});const destroy=vi.fn();
  f.getDocument.mockReturnValue({promise:Promise.resolve({numPages:MAX_OCR_PAGES+1,destroy})});
  const result=await extractDocumentText(Buffer.from("pdf"),"application/pdf","deed.pdf");
  expect(result.ocrStatus).toBe("failed");expect(result.error).toContain("No partial extraction");expect(f.createWorker).not.toHaveBeenCalled();expect(destroy).toHaveBeenCalled();
 });
 it("refuses the live 92-page Buttercup preview with its reason, within the 1.6 GB worker's 40-page bound",async()=>{
  expect(MAX_OCR_PAGES).toBe(40);
  f.parse.mockResolvedValue({text:"",numpages:92});const destroy=vi.fn();
  f.getDocument.mockReturnValue({promise:Promise.resolve({numPages:92,destroy})});
  const result=await extractDocumentText(Buffer.from("pdf"),"application/pdf","2024-630-public-preview.pdf");
  expect(result.ocrStatus).toBe("failed");expect(result.error).toContain("92 pages; exceeds 40-page OCR limit");expect(f.createWorker).not.toHaveBeenCalled();
 });
 it("does not accept a readable first page with an unreadable later page",async()=>{
  f.parse.mockResolvedValue({text:"readable first page ".repeat(5)+"\f",numpages:2});
  const terminate=vi.fn(),destroy=vi.fn();
  f.createWorker.mockResolvedValue({recognize:vi.fn().mockResolvedValueOnce({data:{text:"readable first page ".repeat(5)}}).mockResolvedValueOnce({data:{text:""}}),terminate});
  f.getDocument.mockReturnValue({promise:Promise.resolve({numPages:2,destroy,getPage:async()=>({getViewport:()=>({width:100,height:100}),render:()=>({promise:Promise.resolve()})})})});
  const result=await extractDocumentText(Buffer.from("pdf"),"application/pdf","deed.pdf");
  expect(result.ocrStatus).toBe("failed");expect(result.error).toContain("Page 2 of 2");expect(terminate).toHaveBeenCalled();expect(destroy).toHaveBeenCalled();
 });
 it("reads a 26-page instrument in full rather than rejecting the old bound",async()=>{
  f.parse.mockResolvedValue({text:"",numpages:26});
  const cleanup=vi.fn(),terminate=vi.fn(),destroy=vi.fn(),recognize=vi.fn(async()=>({data:{text:"Complete legible instrument page with sufficient words for extraction."}}));
  f.createWorker.mockResolvedValue({recognize,terminate});
  f.getDocument.mockReturnValue({promise:Promise.resolve({numPages:26,destroy,getPage:async()=>({cleanup,getViewport:()=>({width:100,height:100}),render:()=>({promise:Promise.resolve()})})})});
  const result=await extractDocumentText(Buffer.from("pdf"),"application/pdf","unit.pdf");
  expect(result.ocrStatus).toBe("done");expect(result.pageCount).toBe(26);
  expect(result.text.split("\f")).toHaveLength(26);expect(cleanup).toHaveBeenCalledTimes(26);expect(recognize).toHaveBeenCalledTimes(26);
 });

});
