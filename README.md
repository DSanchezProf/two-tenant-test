# two-tenant-test

The smallest proof that Supabase RLS is doing what you think it is.

Not a pentest. Not a scanner. Two real users, your real API, the response body.

If Tenant A can read or write Tenant B's rows, the Security Advisor being green does not matter.

> ⚠️ **Run this on staging or a throwaway project.** It writes and deletes rows (seeds a row for B, attempts a cross-tenant insert, cleans up). Never point it at production or a real customer org.

## What it checks

- **Cross-tenant read** — A asks for B's rows
- **Cross-tenant write** — A inserts a row stamped as B, *confirmed as B* (not via A's own view)
- **Anon** — the same read with no user JWT

It does not check edge functions, storage, realtime, RPCs, or races. Those are the next pages of the method.

## You need

- Project URL and the anon / publishable key (public by design)
- Two test users in different tenants
- The tenant column name (`org_id`, `team_id`, `account_id`, …) and Tenant B's id
- A row Tenant B already owns (or the script inserts one as B)

Create the two users in the dashboard or with Auth admin. **Do not put `service_role` in this script** — it bypasses RLS and proves nothing.

## Run

```bash
cp .env.example .env
# edit .env
npm install
node test.mjs
```

Exit `0` = the three cases held for that table. Exit `1` = at least one case leaked. Read the lines; do not trust a silent pass.

## Reading the output

| Line | Meaning |
|---|---|
| `READ … HOLD empty array` | A asked for B's rows and got `[]` |
| `READ … FAIL LEAK` | A received B's rows. The policy is theater. |
| `WRITE … HOLD insert rejected by RLS` | RLS blocked A from writing as B |
| `WRITE … SKIP` | The table needs more than the tenant column to insert — can't test the write here without a fuller payload |
| `WRITE … FAIL LEAK` | A's insert as B was allowed (confirmed by looking as B) |
| `ANON … HOLD` | No session → no rows (or an error) |
| `ANON … FAIL LEAK` | The internet can read the table |

**Why confirm the write as B?** A's own `SELECT` policy can hide a row A just inserted — so reading it back as A shows empty even when the write landed. The only honest confirmation is to look as B. A no-error insert is treated as a leak and cleaned up.

A `HOLD` on read with a `FAIL` on write usually means the **write policy is permissive** — `WITH CHECK (true)`, or no `WITH CHECK` on an over-broad policy. Reads and writes are enforced by separate policy clauses. Test both.

## What this is not

A green run on one table is not "the app is secure." It is evidence for that table, those two users, those verbs. Re-run it whenever you change a policy.

---

Part of the field manual on testing AI-built Supabase apps — [@DSanchezProf](https://x.com/DSanchezProf).
