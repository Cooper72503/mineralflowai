#!/usr/bin/env node
/**
 * Bulk ingest mineral deed PDFs into Supabase Storage + `documents`, then run the normal
 * Next.js processing pipeline (extract + score) for each row.
 *
 * Where to put files
 * ------------------
 * Use any local folder you like. Pass its absolute or relative path as the first argument.
 * Example: create `./bulk-pdfs/` in the project root and copy PDFs there (not committed).
 *
 * How to run
 * ----------
 * From the `frontend` directory (needs `node_modules` and env vars):
 *
 *   cd frontend
 *   export NEXT_PUBLIC_SUPABASE_URL="https://YOUR_PROJECT.supabase.co"
 *   export NEXT_PUBLIC_SUPABASE_ANON_KEY="your-anon-key"
 *   export SUPABASE_INGEST_EMAIL="your-login@email.com"
 *   export SUPABASE_INGEST_PASSWORD="your-password"
 *   export APP_ORIGIN="http://localhost:3000"
 *
 *   node scripts/bulk-ingest-pdfs.mjs /path/to/folder/of/pdfs
 *
 * `APP_ORIGIN` is the base URL of the running Next app (processing calls POST /api/documents/:id/process).
 * Start the dev server first: `npm run dev`
 *
 * Optional: BULK_DOCUMENT_TYPE, BULK_COUNTY, BULK_STATE — same role as the upload form metadata.
 */

import { createServerClient } from "@supabase/ssr";
import fs from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";

const BUCKET = "documents";

function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

function requireEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return v;
}

function cookieHeaderFromStore(store) {
  // Match browser behavior: values are already safe strings from @supabase/ssr.
  return Array.from(store.entries())
    .map(([n, val]) => `${n}=${val}`)
    .join("; ");
}

async function main() {
  const folderArg = process.argv[2];
  if (!folderArg) {
    console.error("Usage: node scripts/bulk-ingest-pdfs.mjs <path-to-folder-with-pdfs>");
    process.exit(1);
  }

  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const email = requireEnv("SUPABASE_INGEST_EMAIL");
  const password = requireEnv("SUPABASE_INGEST_PASSWORD");
  const appOrigin = (process.env.APP_ORIGIN || "http://localhost:3000").replace(/\/$/, "");

  const folderAbs = path.resolve(folderArg);
  let entries;
  try {
    entries = await fs.readdir(folderAbs, { withFileTypes: true });
  } catch (e) {
    console.error(`Cannot read folder: ${folderAbs}`, e?.message || e);
    process.exit(1);
  }

  const pdfFiles = entries
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".pdf"))
    .map((d) => d.name)
    .sort();

  const stats = {
    totalFound: pdfFiles.length,
    uploaded: 0,
    failed: 0,
    processed: 0,
    skippedDuplicate: 0,
  };

  const cookieStore = new Map();

  const supabase = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll() {
        return Array.from(cookieStore.entries()).map(([name, value]) => ({ name, value }));
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          if (value === "" || value == null) cookieStore.delete(name);
          else cookieStore.set(name, value);
        }
      },
    },
  });

  const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (signInErr || !signInData?.session?.user) {
    console.error("Sign-in failed:", signInErr?.message || "no session");
    process.exit(1);
  }

  const userId = signInData.session.user.id;
  const cookieHeader = cookieHeaderFromStore(cookieStore);

  const optionalMeta = {
    document_type: process.env.BULK_DOCUMENT_TYPE?.trim() || null,
    county: process.env.BULK_COUNTY?.trim() || null,
    state: process.env.BULK_STATE?.trim() || null,
  };

  const { data: existingRows, error: listErr } = await supabase
    .from("documents")
    .select("file_name")
    .eq("user_id", userId);

  const existingNames = new Set();
  if (listErr) {
    console.warn("[warn] Could not load existing document names; duplicate skip disabled.", listErr.message);
  } else if (existingRows) {
    for (const r of existingRows) {
      if (r.file_name) existingNames.add(r.file_name);
    }
  }

  for (const fileName of pdfFiles) {
    const fullPath = path.join(folderAbs, fileName);
    let documentId = null;

    try {
      if (existingNames.has(fileName)) {
        console.log(`[skip] duplicate file_name for user: ${fileName}`);
        stats.skippedDuplicate += 1;
        continue;
      }

      const buf = await fs.readFile(fullPath);
      const safeName = sanitizeFileName(fileName);
      const storagePath = `${userId}/${Date.now()}-${randomBytes(4).toString("hex")}-${safeName}`;

      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, buf, {
          contentType: "application/pdf",
          upsert: false,
        });

      if (upErr) {
        console.error(`[fail] ${fileName} — storage:`, upErr.message);
        stats.failed += 1;
        continue;
      }

      const insertPayload = {
        user_id: userId,
        file_name: fileName,
        file_path: storagePath,
        file_size: buf.length,
        county: optionalMeta.county,
        state: optionalMeta.state,
        document_type: optionalMeta.document_type,
        status: "uploaded",
        storage_path: storagePath,
      };

      const { data: inserted, error: insErr } = await supabase
        .from("documents")
        .insert(insertPayload)
        .select("id")
        .maybeSingle();

      if (insErr || !inserted?.id) {
        console.error(`[fail] ${fileName} — db insert:`, insErr?.message || "no id");
        await supabase.storage.from(BUCKET).remove([storagePath]).catch(() => {});
        stats.failed += 1;
        continue;
      }

      documentId = inserted.id;
      existingNames.add(fileName);
      stats.uploaded += 1;
      console.log(`[ok] uploaded + row ${documentId} — ${fileName}`);

      const processUrl = `${appOrigin}/api/documents/${documentId}/process`;
      const res = await fetch(processUrl, {
        method: "POST",
        headers: {
          Cookie: cookieHeader,
        },
      });

      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }

      const ok =
        res.ok &&
        body &&
        body.ok === true &&
        (body.status === "completed" || body.document?.status === "completed");

      if (ok) {
        stats.processed += 1;
        console.log(`[ok] processed — ${fileName}`);
      } else {
        const msg =
          body?.error_message ||
          body?.error ||
          (typeof body?.step_failed === "string" ? `step: ${body.step_failed}` : null) ||
          `HTTP ${res.status}`;
        console.error(`[fail] process — ${fileName}:`, msg);
      }
    } catch (err) {
      console.error(`[fail] ${fileName}:`, err instanceof Error ? err.message : err);
      stats.failed += 1;
    }
  }

  console.log("\n--- Summary ---");
  console.log(`Total PDFs found:     ${stats.totalFound}`);
  console.log(`Uploaded (storage+db): ${stats.uploaded}`);
  console.log(`Failed (upload/db):   ${stats.failed}`);
  console.log(`Processed OK:         ${stats.processed}`);
  if (stats.skippedDuplicate) {
    console.log(`Skipped (duplicate):  ${stats.skippedDuplicate}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
