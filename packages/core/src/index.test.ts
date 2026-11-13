import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "./index.ts";

test("пакет core грузится и отдаёт основные точки входа", () => {
  assert.equal(typeof core.CORE_VERSION, "string");
  for (const name of ["openDb", "migrate", "createRepo", "loadConfig", "run"] as const) {
    assert.equal(typeof core[name], "function", name);
  }
});
