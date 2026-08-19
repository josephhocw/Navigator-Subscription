// =============================================================================
// One-off backfill for col W ("Main Group") — 2026-08-19
// =============================================================================
// Everyone already in the main group joined before col W existed, so the
// column starts blank for them. This script checks every row that has a
// Telegram User ID (col P) against the live main group via getChatMember and
// stamps col W with "PRE <today>" for confirmed members. Rows Telegram reports
// as left/kicked/unknown stay blank — blank means "not in the main group".
//
// Rows with no col P ID cannot be checked (Bot API can't resolve a username
// to an ID); they are listed for a manual eyeball against the member list.
//
// Usage (dry-run by default):
//   npx tsx --env-file=.env scripts/backfill-main-group.mts
//   npx tsx --env-file=.env scripts/backfill-main-group.mts --apply
// =============================================================================

import { getAllSubscriberRows, updateRowFields, type SheetRow } from "../lib/sheets.js";

const APPLY = process.argv.includes("--apply");
const MAIN_CHAT_ID = process.env.TELEGRAM_CHAT_MAIN || "-1003175647154";
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BARRED = new Set(["CANCELLED", "TRIAL_CANCELLED"]);

if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set — aborting.");
  process.exit(1);
}

function todayStampSGT(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore" }).format(new Date());
}

async function isMainGroupMember(userId: string): Promise<boolean | "error"> {
  const url = `https://api.telegram.org/bot${TOKEN}/getChatMember?chat_id=${MAIN_CHAT_ID}&user_id=${userId}`;
  try {
    const res = await fetch(url);
    const body = (await res.json()) as {
      ok: boolean;
      result?: { status?: string; is_member?: boolean };
      description?: string;
    };
    if (!body.ok) {
      const desc = (body.description ?? "").toLowerCase();
      // "chat not found" means the TOKEN is wrong (a bot that isn't in the main
      // group — e.g. the machine-level TELEGRAM_BOT_TOKEN user env var, which
      // tsx --env-file does NOT override). Every verdict would be false — abort.
      if (desc.includes("chat not found")) {
        console.error("FATAL: 'chat not found' — this bot token is not the access bot. Aborting.");
        process.exit(1);
      }
      // "member not found" / "PARTICIPANT_ID_INVALID" = Telegram has never
      // seen this user in this chat — treat as not a member, not an error.
      if (desc.includes("not found") || desc.includes("participant_id_invalid")) return false;
      console.warn(`  getChatMember error for ${userId}: ${body.description}`);
      return "error";
    }
    const st = body.result?.status ?? "";
    if (["member", "administrator", "creator"].includes(st)) return true;
    if (st === "restricted") return body.result?.is_member === true;
    return false; // left | kicked
  } catch (err) {
    console.warn(`  getChatMember transport error for ${userId}: ${String(err)}`);
    return "error";
  }
}

async function main(): Promise<void> {
  const stamp = `PRE ${todayStampSGT()}`;
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — backfilling col W with "${stamp}" for confirmed main-group members\n`);

  const rows = await getAllSubscriberRows();
  const withId = rows.filter((r) => r.telegramUserId.trim() !== "");
  const noId: SheetRow[] = rows.filter(
    (r) => r.telegramUserId.trim() === "" && r.status && !BARRED.has(r.status)
  );

  // One Telegram call per distinct user ID; the verdict fans out to all rows.
  const verdicts = new Map<string, boolean | "error">();
  for (const id of new Set(withId.map((r) => r.telegramUserId.trim()))) {
    verdicts.set(id, await isMainGroupMember(id));
    await new Promise((r) => setTimeout(r, 50));
  }

  let stamped = 0;
  let skippedFilled = 0;
  let notMember = 0;
  let errors = 0;
  for (const r of withId) {
    if ((r.mainGroupJoined ?? "").trim() !== "") {
      skippedFilled++;
      continue;
    }
    const verdict = verdicts.get(r.telegramUserId.trim());
    if (verdict === true) {
      console.log(`  row ${r.rowIndex}: IN GROUP — stamp "${stamp}" (@${r.telegramUsername} | ${r.email})`);
      if (APPLY) await updateRowFields(r.rowIndex, { mainGroupJoined: stamp });
      stamped++;
    } else if (verdict === "error") {
      errors++;
    } else {
      notMember++;
    }
  }

  console.log(`\nRows checked: ${withId.length} | stamped: ${stamped} | already filled: ${skippedFilled} | not in group (left blank): ${notMember} | API errors: ${errors}`);
  console.log(`\nUncheckable live rows (no col P ID) — eyeball these against the member list, hand-fill col W if present: ${noId.length}`);
  for (const r of noId) {
    console.log(`  row ${r.rowIndex}: ${r.status} | @${r.telegramUsername || "-"} | ${r.email} | ${r.customerName}`);
  }
  if (!APPLY) console.log(`\nDry run — nothing written. Re-run with --apply to write.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
