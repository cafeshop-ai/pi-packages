import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { listProjectDirectory, readProjectFile } from "./file-commands.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project file commands", () => {
  it("lists and reads files inside the project root", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-collab-")));
    roots.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n");

    const listing = await listProjectDirectory(root, "src") as Record<string, unknown>;
    expect(listing.kind).toBe("directory");
    expect(listing.entries).toEqual([{ name: "index.ts", kind: "file" }]);

    const file = await readProjectFile(root, "src/index.ts") as Record<string, unknown>;
    expect(file.content).toBe("export const value = 1;\n");
  });

  it("rejects traversal and sensitive files", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-collab-")));
    roots.push(root);
    await writeFile(join(root, ".env"), "SECRET=value\n");
    await writeFile(join(root, ".envsecret"), "SECRET=value\n");
    await mkdir(join(root, ".runtime"));
    await writeFile(join(root, ".runtime", "relay.pid"), "12345\n");
    await mkdir(join(root, ".ssh"));

    await expect(listProjectDirectory(root, "..")).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await expect(listProjectDirectory(root, "nested/../.")).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await expect(readProjectFile(root, ".env")).rejects.toMatchObject({ code: "SENSITIVE_PATH" });
    await expect(readProjectFile(root, ".envsecret")).rejects.toMatchObject({ code: "SENSITIVE_PATH" });
    await expect(readProjectFile(root, ".runtime/relay.pid")).rejects.toMatchObject({ code: "SENSITIVE_PATH" });
    await expect(listProjectDirectory(join(root, ".ssh"), ".")).rejects.toMatchObject({ code: "SENSITIVE_PATH" });
    await expect(readProjectFile(root, "safe.txt:stream")).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    if (process.platform === "win32") {
      await expect(readProjectFile(root, ".. ")).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
      await expect(readProjectFile(root, ".env.")).rejects.toMatchObject({ code: "SENSITIVE_PATH" });
      await expect(readProjectFile(root, "NUL.txt")).rejects.toMatchObject({ code: "SENSITIVE_PATH" });
      await expect(readProjectFile(root, "COM¹.txt")).rejects.toMatchObject({ code: "SENSITIVE_PATH" });
      await expect(readProjectFile(root, "CONIN$.txt")).rejects.toMatchObject({ code: "SENSITIVE_PATH" });
      await expect(readProjectFile(root, "COM1 .txt")).rejects.toMatchObject({ code: "SENSITIVE_PATH" });
      await expect(readProjectFile(root, "CON .txt")).rejects.toMatchObject({ code: "SENSITIVE_PATH" });
    }
    const rootListing = await listProjectDirectory(root, ".") as { entries: Array<{ name: string }> };
    expect(rootListing.entries.map((entry) => entry.name)).not.toContain(".runtime");
    expect(rootListing.entries.map((entry) => entry.name)).not.toContain(".ssh");
  });

  it("rejects roots broad enough to expose the user profile", async () => {
    await expect(listProjectDirectory(homedir(), ".")).rejects.toMatchObject({ code: "SENSITIVE_PATH" });
  });

  it("bounds large directory listings and their serialized result", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-collab-")));
    roots.push(root);
    await Promise.all(Array.from({ length: 305 }, (_, index) => writeFile(join(root, `entry-${String(index).padStart(3, "0")}-${"x".repeat(170)}`), "")));
    const listing = await listProjectDirectory(root, ".") as { entries: unknown[]; truncated: boolean };
    expect(listing.entries.length).toBeLessThanOrEqual(300);
    expect(listing.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(listing), "utf8")).toBeLessThan(192 * 1024);
  });

  it("rejects a symlinked or junctioned project root", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "pi-collab-root-")));
    roots.push(parent);
    const root = join(parent, "root");
    const alias = join(parent, "alias");
    await mkdir(root);
    await writeFile(join(root, "target.txt"), "safe\n");
    try {
      await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    } catch {
      // Windows may disable even junction creation in a restricted runner.
      return;
    }
    await expect(readProjectFile(alias, "target.txt")).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await expect(listProjectDirectory(alias, ".")).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });

  it("bounds file offsets and rejects symlink traversal", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pi-collab-")));
    roots.push(root);
    await writeFile(join(root, "target.txt"), "safe\n");
    await writeFile(join(root, "utf8.txt"), "abc€");
    await writeFile(join(root, "replacement.txt"), "ok�\n");
    await writeFile(join(root, "malformed.dat"), Buffer.from([0xc2]));
    await writeFile(join(root, "malformed-overlong-prefix.dat"), Buffer.from([0xe0, 0x80, 0x80]));
    await writeFile(join(root, "malformed-eof.dat"), Buffer.from([0x61, 0xc2]));
    await writeFile(join(root, "malformed-prefix.dat"), Buffer.from([0x61, 0xff, 0xc2, 0x82]));
    await writeFile(join(root, "binary.dat"), Buffer.from([0xff, 0xfe, 0xfd]));

    await expect(readProjectFile(root, "target.txt", -1)).rejects.toMatchObject({ code: "INVALID_OFFSET" });
    await expect(readProjectFile(root, "target.txt", 100_000_001)).rejects.toMatchObject({ code: "INVALID_OFFSET" });
    await expect(readProjectFile(root, "target.txt", 0, 0)).rejects.toMatchObject({ code: "INVALID_LIMIT" });
    await expect(readProjectFile(root, "target.txt", 0, 256 * 1024 + 1)).rejects.toMatchObject({ code: "INVALID_LIMIT" });
    await expect(readProjectFile(root, "binary.dat")).rejects.toMatchObject({ code: "BINARY_FILE" });
    const utf8Prefix = await readProjectFile(root, "utf8.txt", 0, 4) as { content: string; bytesRead: number; truncated: boolean };
    expect(utf8Prefix.content).toBe("abc");
    expect(utf8Prefix.bytesRead).toBe(3);
    expect(utf8Prefix.truncated).toBe(true);
    const replacement = await readProjectFile(root, "replacement.txt") as { content: string };
    expect(replacement.content).toBe("ok�\n");
    await expect(readProjectFile(root, "malformed.dat")).rejects.toMatchObject({ code: "BINARY_FILE" });
    await expect(readProjectFile(root, "malformed-overlong-prefix.dat", 0, 2)).rejects.toMatchObject({ code: "BINARY_FILE" });
    await expect(readProjectFile(root, "malformed-eof.dat")).rejects.toMatchObject({ code: "BINARY_FILE" });
    await expect(readProjectFile(root, "malformed-prefix.dat", 0, 3)).rejects.toMatchObject({ code: "BINARY_FILE" });
    await expect(readProjectFile(root, "utf8.txt", 4)).rejects.toMatchObject({ code: "BINARY_FILE" });

    try {
      await symlink(join(root, "target.txt"), join(root, "link.txt"));
    } catch {
      // Windows may disable symlink creation for unprivileged test runners.
      return;
    }
    await expect(readProjectFile(root, "link.txt")).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });
});
