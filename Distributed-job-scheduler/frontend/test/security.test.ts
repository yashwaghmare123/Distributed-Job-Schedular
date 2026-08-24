import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

describe("frontend security boundary", () => {
  it("contains no direct database or private secret references", () => {
    const root = join(process.cwd(), "app");
    const files: string[] = [];
    const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path); } };
    walk(root);
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(source).not.toMatch(/@prisma\/client|DATABASE_URL|PGPASSWORD|JWT_SECRET|PRIVATE_KEY/);
  });
});
