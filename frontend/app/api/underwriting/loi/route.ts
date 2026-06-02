/**
 * /api/underwriting/loi
 *
 * POST — generates a .docx Letter of Intent from LOI form data + report context.
 * Returns the DOCX file as a binary response.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  BorderStyle, WidthType, AlignmentType, HeadingLevel, PageNumber,
  Footer, Header, HorizontalPositionRelativeFrom, HorizontalPositionAlign,
  ImageRun, PageBreak, convertInchesToTwip,
} from "docx";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function bold(text: string, size = 22) {
  return new TextRun({ text, bold: true, size });
}
function normal(text: string, size = 22) {
  return new TextRun({ text, size });
}
function para(runs: TextRun[], spacing = 120, alignment = AlignmentType.LEFT) {
  return new Paragraph({ children: runs, spacing: { after: spacing }, alignment });
}
function sectionHeader(text: string) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: 24, color: "1e3a5f", allCaps: true })],
    spacing: { before: 300, after: 80 },
    border: { bottom: { color: "3b82f6", space: 2, style: BorderStyle.SINGLE, size: 8 } },
  });
}
function kv(label: string, value: string) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      children: [
        new TableCell({
          width: { size: 35, type: WidthType.PERCENTAGE },
          borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
          children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, size: 20, color: "6b7280" })], spacing: { after: 40 } })],
        }),
        new TableCell({
          width: { size: 65, type: WidthType.PERCENTAGE },
          borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
          children: [new Paragraph({ children: [new TextRun({ text: value || "—", size: 20 })], spacing: { after: 40 } })],
        }),
      ],
    })],
    borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.SINGLE, size: 2, color: "f3f4f6" }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
  });
}
function sigBlock(party: string, name: string) {
  return [
    new Paragraph({ children: [bold(party.toUpperCase(), 20)], spacing: { before: 200, after: 80 } }),
    new Paragraph({ children: [bold(name || party, 20)], spacing: { after: 160 } }),
    new Paragraph({ children: [normal("By: _______________________________________________", 20)], spacing: { after: 80 } }),
    new Paragraph({ children: [normal("Name: _____________________________________________", 20)], spacing: { after: 80 } }),
    new Paragraph({ children: [normal("Title: _____________________________________________", 20)], spacing: { after: 80 } }),
    new Paragraph({ children: [normal("Date: ______________________________________________", 20)], spacing: { after: 80 } }),
  ];
}

const fmt$ = (n: number | null) => n != null
  ? n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M`
  : n >= 1_000 ? `$${Math.round(n / 1_000).toLocaleString()}K`
  : `$${Math.round(n).toLocaleString()}`
  : "—";

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // Auth optional — allow unauthenticated (share page use case)
  // but prefer to check if authed so we can log
  let userId: string | null = null;
  try {
    const supabase = await createSupabaseFromRouteRequest(request);
    const { data: { user } } = await supabase.auth.getUser();
    userId = user?.id ?? null;
  } catch { /* unauthenticated share page — ok */ }

  let body: {
    buyer: string;
    signer: string;
    seller: string;
    price: string;
    deposit: string;
    ddDays: string;
    closingDays: string;
    exclDays: string;
    notes: string;
    report: {
      subject: { lease_name?: string; operator_name?: string; county?: string; state?: string; api_numbers?: string[]; rrc_lease_number?: string };
      executive_summary: {
        current_gross_rate_bbl: { value?: number | null };
        twelve_month_avg_bbl: { value?: number | null };
        npv10_usd: { value?: number | null };
        offer_range_low: { value?: number | null };
        offer_range_high: { value?: number | null };
      };
      acquisition_economics: { offer_range_mid: { value?: number | null } };
      _meta: { trrc_match_tier: string };
      overall_confidence: string;
      generated_at: string;
    };
  };
  try { body = await request.json(); } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const sub = body.report.subject;
  const ex = body.report.executive_summary;

  const propDesc = [sub.lease_name, sub.county ? `${sub.county} County` : null, sub.state]
    .filter(Boolean).join(", ") || "Oil and Gas Interests";

  const apis = sub.api_numbers?.slice(0, 5).join(", ") || "See Exhibit A";
  const rrc = sub.rrc_lease_number || "Not confirmed in public records";
  const operator = sub.operator_name || "See records";
  const currentRate = ex.current_gross_rate_bbl.value != null ? `${Math.round(ex.current_gross_rate_bbl.value).toLocaleString()} BBL/mo` : "Not confirmed";
  const avg12 = ex.twelve_month_avg_bbl.value != null ? `${Math.round(ex.twelve_month_avg_bbl.value).toLocaleString()} BBL/mo` : "Not confirmed";
  const npv10 = ex.npv10_usd.value != null ? fmt$(ex.npv10_usd.value) : "See analysis";
  const priceDisplay = body.price ? `$${parseInt(body.price).toLocaleString()}` : "[PURCHASE PRICE TO BE DETERMINED]";
  const depositDisplay = body.deposit ? `$${parseInt(body.deposit).toLocaleString()} earnest money, refundable during Due Diligence Period` : "[EARNEST MONEY AMOUNT], refundable during Due Diligence Period";

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 22, color: "111827" },
          paragraph: { spacing: { after: 120 } },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          margin: {
            top: convertInchesToTwip(1.1),
            bottom: convertInchesToTwip(1.1),
            left: convertInchesToTwip(1.25),
            right: convertInchesToTwip(1.25),
          },
        },
      },
      headers: {
        default: new Header({
          children: [
            new Paragraph({
              children: [
                new TextRun({ text: "LETTER OF INTENT — ", bold: true, size: 18, color: "6b7280" }),
                new TextRun({ text: propDesc.toUpperCase(), size: 18, color: "6b7280" }),
              ],
              alignment: AlignmentType.RIGHT,
              border: { bottom: { color: "e5e7eb", size: 4, style: BorderStyle.SINGLE, space: 4 } },
            }),
          ],
        }),
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              children: [
                new TextRun({ text: "PRELIMINARY — FOR DISCUSSION ONLY  |  Generated by MineralFlowAI (mineralflowai.com)  |  Page ", size: 16, color: "9ca3af" }),
                new TextRun({ children: [PageNumber.CURRENT], size: 16, color: "9ca3af" }),
                new TextRun({ text: " of ", size: 16, color: "9ca3af" }),
                new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: "9ca3af" }),
              ],
              alignment: AlignmentType.CENTER,
              border: { top: { color: "e5e7eb", size: 4, style: BorderStyle.SINGLE, space: 4 } },
            }),
          ],
        }),
      },
      children: [
        // ── Title block
        new Paragraph({
          children: [bold("LETTER OF INTENT", 36)],
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: 60 },
        }),
        new Paragraph({
          children: [bold("TO PURCHASE OIL AND GAS INTERESTS", 26)],
          alignment: AlignmentType.CENTER,
          spacing: { after: 300 },
        }),

        // ── Date / Parties
        para([bold("Date: "), normal(today)]),
        para([bold("To: "), normal(body.seller || "[SELLER NAME]")]),
        para([bold("From: "), normal(body.buyer || "[BUYER COMPANY]")]),
        para([bold("Re: "), normal(propDesc)]),

        // ── Divider
        new Paragraph({ border: { bottom: { color: "e5e7eb", size: 6, style: BorderStyle.SINGLE } }, spacing: { after: 200 } }),

        sectionHeader("I.  Introduction"),
        para([
          normal(`${body.buyer || "[Buyer Company]"} ("Buyer") is pleased to submit this non-binding Letter of Intent ("LOI") to purchase the following oil and gas interests from ${body.seller || "[Seller]"} ("Seller"), subject to the terms set forth herein.`),
        ], 200),

        sectionHeader("II.  Property Description"),
        kv("Property / Lease", propDesc),
        kv("API Number(s)", apis),
        kv("RRC Lease Number", rrc),
        kv("Operator of Record", operator),
        kv("County / State", [sub.county, sub.state].filter(Boolean).join(", ") || "—"),
        new Paragraph({ spacing: { after: 100 } }),

        sectionHeader("III.  Purchase Price"),
        new Paragraph({
          children: [
            bold("Proposed Purchase Price: "),
            new TextRun({ text: priceDisplay, bold: true, size: 28, color: "15803d" }),
          ],
          spacing: { after: 160 },
        }),
        para([bold("Earnest Money Deposit: "), normal(depositDisplay)]),
        para([bold("Basis for Offer:")]),
        new Paragraph({ children: [normal(`  • Current gross production rate:  ${currentRate}`)], spacing: { after: 60 } }),
        new Paragraph({ children: [normal(`  • 12-month average production:    ${avg12}`)], spacing: { after: 60 } }),
        new Paragraph({ children: [normal(`  • Estimated NPV10 (base case):    ${npv10}`)], spacing: { after: 60 } }),
        new Paragraph({ children: [normal(`  • Diligence basis:                ${body.report._meta.trrc_match_tier.replace(/_/g, " ")} — TRRC public records`)], spacing: { after: 60 } }),
        new Paragraph({ children: [normal(`  • Overall confidence:             ${body.report.overall_confidence.toUpperCase()}`)], spacing: { after: 200 } }),

        sectionHeader("IV.  Due Diligence Period"),
        para([
          normal(`Buyer shall have `),
          bold(`${body.ddDays || "30"} days`),
          normal(` from execution of this LOI ("Due Diligence Period") to complete its investigation of the Property, including but not limited to:`),
        ]),
        ...[
          "(a) Review of all title records, division orders, and conveyance documents;",
          "(b) Review of TRRC production records, inspection records, and violation database;",
          "(c) Review of all LOE statements, run tickets, and purchaser statements;",
          "(d) Review of wellbore records, completion reports, and workover history;",
          "(e) Environmental review and plugging liability assessment;",
          "(f) Confirmation of all regulatory and bonding requirements.",
        ].map(t => new Paragraph({ children: [normal(`  ${t}`)], spacing: { after: 60 } })),
        new Paragraph({ spacing: { after: 100 } }),

        sectionHeader("V.  Exclusivity"),
        para([
          normal(`In consideration of Buyer's diligence efforts, Seller agrees to provide Buyer `),
          bold(`${body.exclDays || "14"} days`),
          normal(` of exclusive negotiating rights from the date of execution. During this period, Seller shall not solicit, negotiate, or accept any competing offers.`),
        ]),

        sectionHeader("VI.  Target Closing"),
        para([
          normal(`Target closing: `),
          bold(`${body.closingDays || "45"} days`),
          normal(` from LOI execution, subject to completion of due diligence and execution of a definitive Purchase and Sale Agreement ("PSA").`),
        ]),

        sectionHeader("VII.  Conditions Precedent"),
        ...[
          "1.  Satisfactory completion of title examination;",
          "2.  Satisfactory completion of all due diligence described in Section IV;",
          "3.  Execution of a definitive PSA acceptable to both parties;",
          "4.  No material adverse change in property condition, production, or regulatory status;",
          "5.  Seller's delivery of all requested documents and records.",
        ].map(t => new Paragraph({ children: [normal(t)], spacing: { after: 80 } })),
        new Paragraph({ spacing: { after: 100 } }),

        sectionHeader("VIII.  Seller Representations (Requested)"),
        para([normal("Seller represents and warrants that, to Seller's knowledge:")]),
        ...[
          "(a) Seller holds good title to the Property, free and clear of material liens;",
          "(b) All TRRC regulatory filings are current and in good standing;",
          "(c) There are no undisclosed environmental liabilities or remediation obligations;",
          "(d) All production revenue has been accurately reported to royalty owners;",
          "(e) All workover and maintenance expenses have been disclosed.",
        ].map(t => new Paragraph({ children: [normal(`  ${t}`)], spacing: { after: 60 } })),
        new Paragraph({ spacing: { after: 100 } }),

        ...(body.notes ? [
          sectionHeader("IX.  Additional Terms"),
          para([normal(body.notes)]),
        ] : []),

        sectionHeader(body.notes ? "X.  Non-Binding Nature" : "IX.  Non-Binding Nature"),
        para([
          normal("This LOI is "),
          bold("non-binding"),
          normal(" and is intended solely to outline the general terms of a possible transaction. Neither party shall have any legal obligation to consummate the transaction unless and until a definitive PSA is executed by both parties."),
        ], 300),

        // ── Signature blocks
        new Paragraph({ border: { bottom: { color: "e5e7eb", size: 6, style: BorderStyle.SINGLE } }, spacing: { after: 300 } }),
        para([bold("ACCEPTED AND AGREED:", 24)]),

        // Two-column signature table
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [new TableRow({
            children: [
              new TableCell({
                width: { size: 48, type: WidthType.PERCENTAGE },
                borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
                children: sigBlock("BUYER", body.buyer),
              }),
              new TableCell({
                width: { size: 4, type: WidthType.PERCENTAGE },
                borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
                children: [new Paragraph({ children: [] })],
              }),
              new TableCell({
                width: { size: 48, type: WidthType.PERCENTAGE },
                borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
                children: sigBlock("SELLER", body.seller),
              }),
            ],
          })],
          borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
        }),

        // ── Disclaimer footer note
        new Paragraph({ spacing: { before: 400 }, border: { top: { color: "e5e7eb", size: 4, style: BorderStyle.SINGLE } } }),
        new Paragraph({
          children: [new TextRun({
            text: `Prepared using MineralFlowAI (mineralflowai.com). PRELIMINARY — FOR DISCUSSION ONLY. This LOI was auto-populated from publicly available TRRC records and preliminary underwriting analysis. All financial figures are estimates only. Buyer should conduct independent verification and have legal counsel review before execution. Production data: TRRC lease-level records as of ${new Date(body.report.generated_at).toLocaleDateString()}.`,
            size: 16,
            color: "9ca3af",
            italics: true,
          })],
          spacing: { before: 80 },
        }),
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);

  const propSlug = (sub.lease_name ?? sub.operator_name ?? "property")
    .replace(/\s+/g, "_").toLowerCase().slice(0, 30);
  const dateStr = new Date().toISOString().slice(0, 10);

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="loi_${propSlug}_${dateStr}.docx"`,
      "Content-Length": buffer.length.toString(),
    },
  });
}
