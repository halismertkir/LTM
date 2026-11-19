import { describe, expect, it } from "vitest";
import { interpolate, translate } from "../src/i18n";
import { en } from "../src/i18n/en";
import { tr } from "../src/i18n/tr";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("i18n dictionaries", () => {
  it("have exactly the same keys in EN and TR", () => {
    expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
  });

  it("have no empty strings", () => {
    for (const [k, v] of [...Object.entries(en), ...Object.entries(tr)])
      expect(v.trim(), k).not.toBe("");
  });

  it("use the same placeholders in both languages", () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(placeholders(tr[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it("define both plural forms for every plural key", () => {
    for (const key of Object.keys(en)) {
      const m = /^(.*)_(one|other)$/.exec(key);
      if (!m) continue;
      expect(Object.keys(en), key).toContain(`${m[1]}_one`);
      expect(Object.keys(en), key).toContain(`${m[1]}_other`);
    }
  });

  it("interpolates variables and leaves unknown ones intact", () => {
    expect(interpolate("Hi {name}, {missing}", { name: "Ada" })).toBe("Hi Ada, {missing}");
    expect(translate("tr", "conv.utterances_other", { count: 3 })).toBe("3 satır");
  });
});
