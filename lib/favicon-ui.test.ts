import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { metadata } from "../app/layout";

describe("Nova dashboard icons", () => {
  it("references public icons with matching PNG dimensions and ICO sizes", () => {
    expect(metadata.icons).toEqual({
      icon: [
        { url: "/favicon.ico", sizes: "16x16 32x32 48x48", type: "image/x-icon" },
        { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
        { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      ],
      apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    });
    for (const [name, size] of [["favicon-16x16.png", 16], ["favicon-32x32.png", 32], ["apple-touch-icon.png", 180]] as const) {
      const png = readFileSync(`public/${name}`);
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size]);
    }
    const ico = readFileSync("public/favicon.ico");
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 3]);
    [16, 32, 48].forEach((size, index) => {
      const entry = 6 + index * 16;
      expect([ico[entry], ico[entry + 1]]).toEqual([size, size]);
      const png = ico.subarray(ico.readUInt32LE(entry + 12), ico.readUInt32LE(entry + 12) + ico.readUInt32LE(entry + 8));
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size]);
    });
  });
});
