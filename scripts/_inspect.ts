import { desc, eq } from "drizzle-orm";
import { db, observations } from "../lib/db";

async function main() {
  const rows = await db
    .select()
    .from(observations)
    .where(eq(observations.trainPresent, true))
    .orderBy(desc(observations.capturedAt))
    .limit(30);

  console.log(`train-positive observations: ${rows.length}\n`);
  for (const o of rows) {
    const local = o.capturedAt.toLocaleString("en-US", {
      timeZone: "America/Chicago",
    });
    console.log(
      `#${String(o.id).padStart(4)} ${local.padEnd(24)} ${o.isDaylight ? "DAY  " : "NIGHT"}` +
        ` conf=${o.confidence?.toFixed(2) ?? "—"}` +
        ` cv=${o.cvScore?.toFixed(1).padStart(6) ?? "—"}` +
        ` gates=${(o.gates ?? "?").padEnd(7)}` +
        ` img=${o.imageUrl ? "yes" : "no"}`,
    );
    const raw = o.rawVlm as { notes?: string } | null;
    if (raw?.notes) console.log(`      notes: ${raw.notes}`);
    if (o.imageUrl) console.log(`      ${o.imageUrl}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
