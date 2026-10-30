import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";

import { loadConfig } from "#/config";
import {
  displaySecretKey,
  entryNames,
  fastHash,
  generateKeyPair,
  planActions,
  slowHash,
  writeKeysFile,
  type DbProject,
  type KeyCheck,
} from "#/provision/keys";

const sales: DbProject = { id: "p-sales", name: "sales", org: "acme" };
const ops: DbProject = { id: "p-ops", name: "ops-team", org: "acme" };
const pair = (id: string) => ({ publicKey: `pk-lf-${id}`, secretKey: `sk-lf-${id}` });

describe("the key storage scheme Langfuse checks against", () => {
  it("looks a key up by sha256(secret + SALT)", () => {
    expect(fastHash("sk-lf-abc", "salt")).toBe(
      createHash("sha256").update("sk-lf-abcsalt").digest("hex"),
    );
  });

  it("verifies with bcrypt at cost 11", async () => {
    const hash = await slowHash("sk-lf-abc");
    expect(hash).toMatch(/^\$2[aby]\$11\$/);
    expect(await bcrypt.compare("sk-lf-abc", hash)).toBe(true);
  });

  it("displays the first 6 and last 4 characters", () => {
    expect(displaySecretKey("sk-lf-1234567890")).toBe("sk-lf-...7890");
  });

  it("mints keys in Langfuse's own format", () => {
    const { publicKey, secretKey } = generateKeyPair();
    expect(publicKey).toMatch(/^pk-lf-[0-9a-f-]{36}$/);
    expect(secretKey).toMatch(/^sk-lf-[0-9a-f-]{36}$/);
  });
});

const plan = (
  file: Record<string, { id?: string; publicKey: string; secretKey: string }>,
  checks: [string, KeyCheck][],
  extra = {},
) =>
  planActions({
    projects: [ops, sales],
    file: { projects: file },
    checks: new Map(checks),
    ...extra,
  }).map((a) => [a.kind, a.name, ...(a.kind === "rotate" ? [a.revokeOld] : [])]);

describe("planActions", () => {
  it("creates a key for every project without one", () => {
    expect(plan({}, [])).toEqual([
      ["create", "ops-team"],
      ["create", "sales"],
    ]);
  });

  it("keeps a recorded key that still reads its own project", () => {
    expect(
      plan({ sales: { id: "p-sales", ...pair("s") } }, [
        ["sales", { status: "live", projectId: "p-sales" }],
      ]),
    ).toEqual([
      ["create", "ops-team"],
      ["keep", "sales"],
    ]);
  });

  it("replaces a dead key and revokes it, but never revokes a key live on another project", () => {
    expect(
      plan(
        {
          sales: { id: "p-sales", ...pair("s") },
          "ops-team": { id: "p-ops", ...pair("o") },
        },
        [
          ["sales", { status: "dead" }],
          ["ops-team", { status: "live", projectId: "p-elsewhere" }],
        ],
      ),
    ).toEqual([
      ["rotate", "ops-team", false],
      ["rotate", "sales", true],
    ]);
  });

  it("blocks a project whose key could not be checked, rather than minting blind", () => {
    expect(
      plan({ sales: { id: "p-sales", ...pair("s") } }, [
        ["sales", { status: "error", message: "unreachable" }],
      ]),
    ).toEqual([
      ["create", "ops-team"],
      ["blocked", "sales"],
    ]);
  });

  it("finds an entry by id even when the project was renamed", () => {
    expect(
      plan({ "old-name": { id: "p-sales", ...pair("s") } }, [
        ["old-name", { status: "live", projectId: "p-sales" }],
      ]),
    ).toContainEqual(["keep", "sales"]);
  });

  it("drops entries for projects that are gone, but not on a filtered run", () => {
    const file = { gone: { id: "p-gone", ...pair("g") } };
    expect(plan(file, [])).toContainEqual(["drop", "gone"]);
    expect(plan(file, [], { only: ["sales"] })).toEqual([["create", "sales"]]);
  });

  it("honours --only and --exclude by name or id", () => {
    expect(plan({}, [], { only: ["p-ops"] })).toEqual([["create", "ops-team"]]);
    expect(plan({}, [], { exclude: ["sales"] })).toEqual([["create", "ops-team"]]);
  });

  it("tells two same-named projects apart by id", () => {
    const names = entryNames([sales, { id: "p-2", name: "sales", org: "other" }, ops]);
    expect([...names.values()]).toEqual(["sales#p-sales", "sales#p-2", "ops-team"]);
  });
});

describe("writeKeysFile", () => {
  it("writes mode 0600 in a format the server loads", () => {
    const path = join(mkdtempSync(join(tmpdir(), "langfuse-keys-")), "nested", "keys.json");
    writeKeysFile(path, {
      host: "https://lf.example.com",
      projects: { sales: { id: "p-sales", ...pair("s") } },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).projects.sales.id).toBe("p-sales");
    const config = loadConfig({}, path);
    expect(config.problems).toEqual([]);
    expect(config.projects).toMatchObject([
      { name: "sales", expect: ["sales", "p-sales"], source: "keys file" },
    ]);
  });
});
