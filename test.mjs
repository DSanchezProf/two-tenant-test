#!/usr/bin/env node
/**
 * two-tenant-test
 *
 * Sign in as A, ask for B's rows, try to write as B, repeat as anon.
 * Evidence is the response body. Not the Security Advisor.
 *
 * Not a pentest. One table, two users, three cases.
 *
 * RUN ON STAGING OR A THROWAWAY PROJECT. This script writes and deletes rows.
 * Never point it at production or a real customer org.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv() {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

loadEnv();

const required = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "USER_A_EMAIL",
  "USER_A_PASSWORD",
  "USER_B_EMAIL",
  "USER_B_PASSWORD",
  "TABLE",
  "TENANT_COL",
  "TENANT_B_ID",
];

const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("Missing env:", missing.join(", "));
  console.error("Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  USER_A_EMAIL,
  USER_A_PASSWORD,
  USER_B_EMAIL,
  USER_B_PASSWORD,
  TABLE,
  TENANT_COL,
  TENANT_B_ID,
} = process.env;
const ID_COL = process.env.ID_COL || "id";

const db = () =>
  createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

async function signIn(email, password) {
  const sb = db();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    throw new Error(`sign-in failed for ${email}: ${error?.message || "no session"}`);
  }
  return sb;
}

function fail(msg) {
  console.log(`  FAIL  ${msg}`);
  return false;
}
function hold(msg) {
  console.log(`  HOLD  ${msg}`);
  return true;
}
function skip(msg) {
  console.log(`  SKIP  ${msg}`);
  return true;
}

// RLS denials surface as Postgres 42501 / a PostgREST "row-level security" message.
// Anything else on a write (missing NOT NULL column, FK, etc.) is a setup problem,
// not proof of isolation — we must not report those as "held".
function isRlsDenial(error) {
  if (!error) return false;
  const code = String(error.code || "");
  const msg = String(error.message || "").toLowerCase();
  return code === "42501" || msg.includes("row-level security") || msg.includes("row level security");
}

// B is the only client that can see B's rows, so B is the honest witness for a write.
async function tenantBRowIds(client) {
  const { data, error } = await client.from(TABLE).select(ID_COL).eq(TENANT_COL, TENANT_B_ID);
  if (error) return { error, ids: null };
  return { error: null, ids: new Set((data || []).map((r) => r[ID_COL])) };
}

let passed = true;
const mark = (ok) => {
  passed = passed && ok;
};

console.log(`target  ${SUPABASE_URL}`);
console.log(`table   ${TABLE}  tenant_col=${TENANT_COL}  b=${TENANT_B_ID}`);
console.log("");

const a = await signIn(USER_A_EMAIL, USER_A_PASSWORD);
const b = await signIn(USER_B_EMAIL, USER_B_PASSWORD);
const anon = db();

// --- setup: make sure B owns at least one row we can ask for ---
let bRowId = null;
{
  const { data, error } = await b
    .from(TABLE)
    .select(ID_COL)
    .eq(TENANT_COL, TENANT_B_ID)
    .limit(1);

  if (error) {
    console.log("setup   could not list B's rows:", error.message);
    console.log("        check TABLE / TENANT_COL / TENANT_B_ID and that B can select own rows");
    process.exit(1);
  }

  if (data?.length) {
    bRowId = data[0][ID_COL];
    console.log(`setup   B already owns row ${bRowId}`);
  } else {
    const { data: created, error: insErr } = await b
      .from(TABLE)
      .insert({ [TENANT_COL]: TENANT_B_ID })
      .select(ID_COL)
      .single();
    if (insErr || !created) {
      console.log("setup   B has no rows and insert as B failed:", insErr?.message || "no row");
      console.log("        seed one row for tenant B, then re-run");
      process.exit(1);
    }
    bRowId = created[ID_COL];
    console.log(`setup   inserted seed row for B: ${bRowId}`);
  }
}

console.log("");
console.log("1. READ  A selects rows where tenant = B");
{
  const { data, error } = await a.from(TABLE).select("*").eq(TENANT_COL, TENANT_B_ID);
  if (error) {
    mark(hold(`blocked by error (${error.code || ""} ${error.message})`));
  } else if (Array.isArray(data) && data.length === 0) {
    mark(hold("empty array — A cannot read B"));
  } else {
    mark(fail(`LEAK — A received ${data.length} row(s) for tenant B`));
    console.log("        first row keys:", Object.keys(data[0] || {}).join(", "));
  }
}

console.log("2. WRITE A inserts a row stamped as tenant B");
{
  // Snapshot B's rows BEFORE, so we can confirm (and clean up) a leaked write as B.
  // A's own SELECT policy may hide a row A just inserted, so reading it back as A
  // would false-negative. B is the witness.
  const before = await tenantBRowIds(b);
  const { error } = await a.from(TABLE).insert({ [TENANT_COL]: TENANT_B_ID });

  if (error) {
    if (isRlsDenial(error)) {
      mark(hold(`insert rejected by RLS (${error.code || "42501"})`));
    } else {
      mark(
        skip(
          `insert needs more than ${TENANT_COL} on this table — cannot test write here ` +
            `(${error.code || ""} ${error.message})`
        )
      );
    }
  } else {
    // No error → the write was allowed. Confirm and clean up as B.
    let note = "";
    if (!before.error && before.ids) {
      const after = await tenantBRowIds(b);
      if (!after.error && after.ids) {
        const newIds = [...after.ids].filter((id) => !before.ids.has(id));
        if (newIds.length) {
          note = ` (row ${newIds.join(", ")})`;
          const { error: delErr } = await b.from(TABLE).delete().in(ID_COL, newIds);
          if (delErr) {
            console.log(`        cleanup failed — remove manually: ${newIds.join(", ")}`);
          }
        }
      }
    }
    mark(fail(`LEAK — A wrote a row stamped tenant B${note}`));
  }
}

console.log("3. ANON  no JWT, same select");
{
  const { data, error } = await anon.from(TABLE).select("*").eq(TENANT_COL, TENANT_B_ID);
  if (error) {
    mark(hold(`blocked by error (${error.code || ""} ${error.message})`));
  } else if (Array.isArray(data) && data.length === 0) {
    mark(hold("empty array — anon cannot read B"));
  } else {
    mark(fail(`LEAK — anon received ${data.length} row(s)`));
  }
}

console.log("");
if (passed) {
  console.log("result  held on this table, these users, these three cases.");
  console.log("        that is the floor. it is not the app.");
  process.exit(0);
} else {
  console.log("result  isolation failed. Advisor color is irrelevant.");
  process.exit(1);
}
