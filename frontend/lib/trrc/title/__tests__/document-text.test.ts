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
 it("does not accept a readable first page with an unreadable later page",async()=>{
  f.parse.mockResolvedValue({text:"readable first page ".repeat(5)+"\f",numpages:2});
  const terminate=vi.fn(),destroy=vi.fn();
  f.createWorker.mockResolvedValue({recognize:vi.fn().mockResolvedValueOnce({data:{text:"readable first page ".repeat(5)}}).mockResolvedValueOnce({data:{text:""}}),terminate});
  f.getDocument.mockReturnValue({promise:Promise.resolve({numPages:2,destroy,getPage:async()=>({getViewport:()=>({width:100,height:100}),render:()=>({promise:Promise.resolve()})})})});
  const result=await extractDocumentText(Buffer.from("pdf"),"application/pdf","deed.pdf");
  expect(result.ocrStatus).toBe("failed");expect(result.error).toContain("Page 2 of 2");expect(terminate).toHaveBeenCalled();expect(destroy).toHaveBeenCalled();
 });
});
